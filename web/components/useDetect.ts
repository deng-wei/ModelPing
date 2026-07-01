import { useRef, useState } from "preact/hooks";
import type { Dispatch, StateUpdater } from "preact/hooks";
import type { HistoryEntry, Protocol, TestResult } from "../lib/types.js";
import { EMPTY_USAGE, runTestDual, type TestPayload } from "../lib/api.js";
import { CUSTOM_PROVIDER_ID } from "../lib/presets.js";
import { PROTOCOLS, protocolsForModel, type ModelRow, type ProtocolProbe } from "./ModelTable.js";
import type { ConnValue } from "./ConnectionPanel.js";
import type { ConfigState, ProviderPreset, StreamVerdict } from "../lib/types.js";
import { useI18n } from "../lib/i18n.js";
import { runConcurrent } from "../lib/concurrency.js";

export interface BatchProgress {
  completed: number;
  total: number;
}

export interface DetectDeps {
  // 当前连接/参数的 ref，供并发探测闭包读取最新值（避免闭包捕获过期 state）。
  connRef: { current: ConnValue };
  configRef: { current: ConfigState };
  providers: ProviderPreset[];
  setRows: Dispatch<StateUpdater<ModelRow[]>>;
  historyRef: { current: HistoryEntry[] };
  addHistoryEntry: (entry: HistoryEntry) => void;
  showToast: (msg: string) => void;
}

// 模型检测引擎：单行 4 协议探测 + 并发池批量执行。
// 从 App 抽出的自包含单元——只依赖传入的 ref/setter，不持有连接/参数 state。
export function useDetect(deps: DetectDeps) {
  const { connRef, configRef, providers, setRows, addHistoryEntry, showToast } = deps;
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BatchProgress>({ completed: 0, total: 0 });
  const batchControllerRef = useRef<AbortController | null>(null);
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
  const detectRow = async (row: ModelRow, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
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

      try {
        const dual = await runTestDual(payload, signal);
        const jsonResult = dual.json;
        const streamVerdict: StreamVerdict = dual.streamVerdict;
        const streamTtftMs = dual.streamTtftMs;
        const sres = dual.stream;

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
        addHistoryEntry(entry);
      } catch (e: any) {
        // 兜底：即使 runTestJson/runTestStream 已不抛异常，
        // 仍可能因其他运行时错误导致探测失败。确保探针被更新，避免卡在 testing。
        if (signal?.aborted) return; // 取消时不更新，由 resetTestingProbes 处理
        const errResult: TestResult = {
          ok: false, status: 0, latencyMs: 0, ttftMs: null, usage: EMPTY_USAGE,
          text: "", error: e?.message ?? String(e), attempts: 0,
        };
        patchProbe(row.key, proto, {
          status: "fail",
          result: errResult,
          streamVerdict: null,
          streamTtftMs: null,
        });
      }
    }));

    return anyPass;
  };

  // 并发池执行一批行的自动检测。
  const resetTestingProbes = () => {
    setRowsRef.current((rows) => rows.map((row) => {
      let changed = false;
      const probes = { ...row.probes };
      for (const protocol of PROTOCOLS) {
        if (probes[protocol].status === "testing") {
          probes[protocol] = { protocol, status: "idle", result: null, streamVerdict: null, streamTtftMs: null };
          changed = true;
        }
      }
      return changed ? { ...row, probes } : row;
    }));
  };

  const cancelBatch = () => batchControllerRef.current?.abort();

  const runBatch = async (targets: ModelRow[]) => {
    if (!targets.length || busy) return;
    const controller = new AbortController();
    batchControllerRef.current = controller;
    setBusy(true);
    setProgress({ completed: 0, total: targets.length });
    let passed = 0;
    let completed = 0;
    const concurrency = Math.min(10, Math.max(1, Math.trunc(configRef.current.concurrency || 2)));
    try {
      await runConcurrent(
        targets,
        concurrency,
        controller.signal,
        async (row, signal) => {
          if (await detectRow(row, signal)) passed++;
        },
        () => {
          completed++;
          setProgress({ completed, total: targets.length });
        },
      );
      if (controller.signal.aborted) {
        resetTestingProbes();
        showToast(t("app.batchCanceled", { completed, total: targets.length }));
      } else {
        const total = targets.length;
        showToast(passed === total ? t("app.batchAllPass", { total }) : t("app.batchPartial", { passed, total }));
      }
    } catch (e: any) {
      // 非取消类的意外错误：重置仍处于 testing 的探针，避免卡死。
      resetTestingProbes();
      showToast(e?.message ?? String(e));
    } finally {
      if (batchControllerRef.current === controller) batchControllerRef.current = null;
      setBusy(false);
    }
  };

  return { busy, progress, runBatch, cancelBatch };
}
