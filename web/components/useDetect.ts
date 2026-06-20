import { useRef, useState } from "preact/hooks";
import type { Dispatch, StateUpdater } from "preact/hooks";
import type { HistoryEntry, Protocol, TestResult } from "../lib/types.js";
import { EMPTY_USAGE, runTestJson, runTestStream, type TestPayload } from "../lib/api.js";
import { appendHistory } from "../lib/storage.js";
import { CUSTOM_PROVIDER_ID } from "../lib/presets.js";
import { PROTOCOLS, protocolsForModel, type ModelRow, type ProtocolProbe } from "./ModelTable.js";
import type { ConnValue } from "./ConnectionPanel.js";
import type { ConfigState } from "../lib/storage.js";
import type { ProviderPreset, StreamVerdict } from "../lib/types.js";
import { useI18n } from "../lib/i18n.js";

const CONCURRENCY = 3; // 批量检测的模型级并发上限（每个模型内部再并发协议）

export interface DetectDeps {
  // 当前连接/参数的 ref，供并发探测闭包读取最新值（避免闭包捕获过期 state）。
  connRef: { current: ConnValue };
  configRef: { current: ConfigState };
  providers: ProviderPreset[];
  setRows: Dispatch<StateUpdater<ModelRow[]>>;
  historyRef: { current: HistoryEntry[] };
  setHistory: Dispatch<StateUpdater<HistoryEntry[]>>;
  showToast: (msg: string) => void;
}

// 模型检测引擎：单行 4 协议探测 + 并发池批量执行。
// 从 App 抽出的自包含单元——只依赖传入的 ref/setter，不持有连接/参数 state。
export function useDetect(deps: DetectDeps) {
  const { connRef, configRef, providers, setRows, historyRef, setHistory, showToast } = deps;
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  // setRows 的稳定引用，避免把它列进各回调依赖。
  const setRowsRef = useRef(setRows);
  setRowsRef.current = setRows;

  // 更新单个协议探针（按 行 key + 协议）。
  const patchProbe = (rowKey: string, protocol: Protocol, patch: Partial<ProtocolProbe>) => {
    setRowsRef.current((rs) => rs.map((r) =>
      r.key === rowKey
        ? { ...r, probes: { ...r.probes, [protocol]: { ...r.probes[protocol], ...patch } } }
        : r,
    ));
  };

  // 自动检测单行：按模型族挑协议，非流式 + 流式独立并行探测。返回是否有任一协议通过。
  const detectRow = async (row: ModelRow): Promise<boolean> => {
    const c = connRef.current;
    const cfg = configRef.current;

    const model = c.providerId === CUSTOM_PROVIDER_ID ? row.label : row.modelByProvider[c.providerId] ?? row.label;
    // 按模型族挑选要测的协议；未选中的协议标记为「跳过」，不发请求、不写历史。
    const toTest = protocolsForModel(`${row.label} ${model}`);
    const skipped = PROTOCOLS.filter((p) => !toTest.includes(p));

    if (!c.baseUrl || !c.apiKey) {
      const errResult: TestResult = {
        ok: false, status: 0, latencyMs: 0, ttftMs: null, usage: EMPTY_USAGE,
        text: "", error: t("conn.fillFirst"), attempts: 0,
      };
      for (const p of toTest) patchProbe(row.key, p, { status: "fail", result: errResult, streamVerdict: null, streamTtftMs: null });
      for (const p of skipped) patchProbe(row.key, p, { status: "skipped", result: null, streamVerdict: null, streamTtftMs: null });
      return false;
    }

    // 重置探针：待测协议进入测试中，其余标记跳过。
    for (const p of toTest) patchProbe(row.key, p, { status: "testing", result: null, streamVerdict: null, streamTtftMs: null });
    for (const p of skipped) patchProbe(row.key, p, { status: "skipped", result: null, streamVerdict: null, streamTtftMs: null });

    const provider = providers.find((p) => p.id === c.providerId);
    const providerName = provider?.name ?? (c.providerId === CUSTOM_PROVIDER_ID ? t("common.custom") : c.providerId);

    let anyPass = false;

    await Promise.all(toTest.map(async (proto) => {
      const payload: TestPayload = {
        protocol: proto,
        baseUrl: c.baseUrl,
        isFullUrl: Boolean(c.isFullUrl),
        apiKey: c.apiKey,
        model,
        input: cfg.input,
        stream: false,
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
        maxTokens: cfg.maxTokens,
        userAgent: cfg.userAgent,
      };

      // 非流式与流式独立并行探测：流式不再依赖非流式先通过，
      // 这样只支持流式的端点也能被正确识别。
      const streamProbe = (async () => {
        let gotDelta = false;
        let ttft: number | null = null;
        const sres = await runTestStream({ ...payload, stream: true }, (ev) => {
          if (ev.type === "delta") gotDelta = true;
          else if (ev.type === "ttft") ttft = ev.ttftMs;
        });
        // 判定收紧：仅当收到 ≥1 个 delta 才算真流式；
        // stream:true 却一次性返回（无增量）判为 single，避免假阳性。
        const verdict: StreamVerdict = gotDelta ? "stream" : sres.ok ? "single" : "none";
        return { verdict, ttftMs: ttft ?? sres.ttftMs, sres };
      })();

      const jsonResult = await runTestJson(payload);
      const { verdict: streamVerdict, ttftMs: streamTtftMs, sres } = await streamProbe;

      // 展示结果：优先非流式；非流式失败但流式成功时回退到流式结果。
      const result = jsonResult.ok ? jsonResult : sres.ok ? sres : jsonResult;
      const protoOk = result.ok;
      if (protoOk) anyPass = true;
      patchProbe(row.key, proto, {
        status: protoOk ? "success" : "fail",
        result,
        streamVerdict,
        streamTtftMs,
      });

      // 写历史：每个「模型×协议」一条（非流式结果 + 流式结论）。
      const entry: HistoryEntry = {
        id: `${Date.now()}-${row.key}-${proto}-${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        providerName,
        protocol: proto,
        baseUrl: c.baseUrl,
        isFullUrl: Boolean(c.isFullUrl),
        apiKey: c.apiKey,
        userAgent: cfg.userAgent,
        model,
        modelLabel: row.label,
        streamVerdict,
        result,
      };
      const next = appendHistory(historyRef.current, entry);
      historyRef.current = next;
      setHistory(next);
    }));

    return anyPass;
  };

  // 并发池执行一批行的自动检测。
  const runBatch = async (targets: ModelRow[]) => {
    if (!targets.length || busy) return;
    setBusy(true);
    const queue = [...targets];
    let passed = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const row = queue.shift()!;
        if (await detectRow(row)) passed++;
      }
    });
    await Promise.all(workers);
    setBusy(false);
    const total = targets.length;
    showToast(
      passed === total
        ? t("app.batchAllPass", { total })
        : t("app.batchPartial", { passed, total }),
    );
  };

  return { busy, runBatch };
}
