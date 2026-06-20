import { useEffect, useRef, useState } from "preact/hooks";
import type { Defaults, HistoryEntry, PresetsResponse, ProviderPreset, Protocol, StreamVerdict, TestResult } from "../lib/types.js";
import { EMPTY_USAGE, fetchHealth, fetchPresets, fetchSettings, saveSettings, runTestJson, runTestStream, setAppPassword, type TestPayload } from "../lib/api.js";
import {
  appendHistory, getPersist, loadConfig, loadConn, loadHistory,
  saveConfig, saveConn, setPersist as persistSetPersist, clearHistory,
  type ConfigState, type ConnState,
} from "../lib/storage.js";
import {
  CUSTOM_PROVIDER_ID,
  FALLBACK_DEFAULTS,
  loadLocalPresets, saveLocalPresets,
} from "../lib/presets.js";
import { initTheme } from "../lib/theme.js";
import { ConnectionPanel, type ConnValue } from "./ConnectionPanel.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { ModelTable, PROTOCOLS, protocolsForModel, freshProbes, type ModelRow, type ProtocolProbe } from "./ModelTable.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { LangToggle } from "./LangToggle.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { initLang, useI18n } from "../lib/i18n.js";

const CONCURRENCY = 3; // 批量检测的模型级并发上限（每个模型内部再并发 4 协议）

let rowSeq = 0;
const nextKey = () => `r${++rowSeq}`;

// 由全部供应商预设生成按官方名去重的模型行（每行含 4 个 idle 协议探针）。
function buildRows(providers: ProviderPreset[], selectedProviderId = CUSTOM_PROVIDER_ID): ModelRow[] {
  const byLabel = new Map<string, ModelRow>();
  for (const provider of providers) {
    for (const m of provider.models) {
      const label = (m.label ?? m.id).trim();
      if (!label) continue;
      const existing = byLabel.get(label);
      if (existing) {
        existing.modelByProvider[provider.id] = m.id;
        if (selectedProviderId !== CUSTOM_PROVIDER_ID && provider.id === selectedProviderId) {
          existing.checked = true;
        }
      } else {
        byLabel.set(label, {
          key: nextKey(),
          label,
          modelByProvider: { [provider.id]: m.id },
          custom: false,
          checked: selectedProviderId !== CUSTOM_PROVIDER_ID && provider.id === selectedProviderId,
          probes: freshProbes(),
        });
      }
    }
  }
  return [...byLabel.values()];
}

function selectRowsForProvider(rows: ModelRow[], providerId: string): ModelRow[] {
  return rows.map((row) => ({
    ...row,
    checked: providerId === CUSTOM_PROVIDER_ID ? row.custom : !row.custom && providerId in row.modelByProvider,
    probes: freshProbes(),
  }));
}

export function App() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [presetDefaults, setPresetDefaults] = useState<Defaults>(FALLBACK_DEFAULTS);
  const [activeTab, setActiveTab] = useState<"test" | "settings">("test");
  const [conn, setConn] = useState<ConnValue>({ providerId: CUSTOM_PROVIDER_ID, baseUrl: "", isFullUrl: false, apiKey: "" });
  const [config, setConfig] = useState<ConfigState>({ input: "", timeoutMs: 30000, maxRetries: 1, maxTokens: 512, userAgent: "" });
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [persist, setPersistState] = useState<boolean>(getPersist());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // 口令门：need=后端要求口令，authed=已通过。
  const [needPassword, setNeedPassword] = useState(false);
  const [authed, setAuthed] = useState(true);
  const [pwInput, setPwInput] = useState("");

  // 服务端是否启用了持久化（presets 跨设备共享）。null=未知，初始化时探测。
  const serverPersistRef = useRef<boolean>(false);
  // ConfigPanel 参数 → defaults 同步到后端的防抖句柄。
  const configSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const historyRef = useRef(history);
  historyRef.current = history;

  // 当前连接/参数的 ref，供并发探测闭包读取最新值。
  const connRef = useRef(conn);
  connRef.current = conn;
  const configRef = useRef(config);
  configRef.current = config;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  // 应用主题（system 模式跟随系统切换）与语言（<html lang> + 标题）。
  useEffect(() => {
    initTheme();
    initLang();
  }, []);

  // 初始化：健康检查（是否需口令）→ 拉预设 → 恢复上次配置。
  const init = async () => {
    setLoadErr(null);
    try {
      const health = await fetchHealth();
      if (health.needPassword) {
        setNeedPassword(true);
        const saved = sessionStorage.getItem("app_password");
        if (!saved) {
          setAuthed(false);
          return; // 等用户输入口令
        }
      }
      // 静态默认（重置目标 + 兜底）。
      const fetchedPresets = await fetchPresets();
      // 预设来源优先级：服务端（跨设备共享）→ 本地缓存 → 静态默认。
      const serverPresets = await fetchSettings();
      serverPersistRef.current = serverPresets !== null;
      const activePresets = serverPresets ?? loadLocalPresets() ?? fetchedPresets;
      // 服务端可用时，把结果回写本地作镜像缓存（离线/失败时仍可用）。
      if (serverPresets) saveLocalPresets(serverPresets);
      const { providers: provs, defaults: defs } = activePresets;
      setPresetDefaults(defs);
      setProviders(provs);
      setHistory(loadHistory());

      // 恢复参数配置
      const savedCfg = loadConfig();
      const cfg: ConfigState = {
        input: savedCfg?.input ?? defs.input,
        timeoutMs: savedCfg?.timeoutMs ?? defs.timeoutMs,
        maxRetries: savedCfg?.maxRetries ?? defs.maxRetries,
        maxTokens: savedCfg?.maxTokens ?? defs.maxTokens,
        userAgent: savedCfg?.userAgent ?? defs.userAgent ?? "",
      };
      setConfig(cfg);

      // 恢复连接字段（含 key），但供应商始终默认「自定义」。
      const savedConn = loadConn();
      setConn({
        providerId: CUSTOM_PROVIDER_ID,
        baseUrl: savedConn?.baseUrl ?? "",
        isFullUrl: Boolean(savedConn?.isFullUrl),
        apiKey: savedConn?.apiKey ?? "",
      });
      setRows(buildRows(provs, CUSTOM_PROVIDER_ID));
      setAuthed(true);
    } catch (e: any) {
      setLoadErr(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 提交口令后重试初始化。
  const submitPassword = async () => {
    if (!pwInput.trim()) return;
    setAppPassword(pwInput.trim());
    setAuthed(true);
    await init();
  };

  // 连接变更：切换供应商时调整模型勾选并重置探针；其余仅更新字段。持久化连接配置。
  const onConnChange = (v: ConnValue) => {
    const providerChanged = v.providerId !== conn.providerId;
    setConn(v);
    saveConn({ providerId: v.providerId, baseUrl: v.baseUrl, isFullUrl: Boolean(v.isFullUrl), apiKey: v.apiKey } as ConnState);
    if (providerChanged) setRows((rs) => selectRowsForProvider(rs, v.providerId));
  };

  const onConfigChange = (v: ConfigState) => {
    setConfig(v);
    saveConfig(v);
    // 参数当默认值同步到后端 defaults（防抖，避免逐字输入狂发请求）。
    if (serverPersistRef.current) {
      if (configSyncRef.current) clearTimeout(configSyncRef.current);
      configSyncRef.current = setTimeout(() => {
        const nextDefaults: Defaults = {
          input: v.input,
          stream: presetDefaults.stream,
          timeoutMs: v.timeoutMs,
          maxRetries: v.maxRetries,
          maxTokens: v.maxTokens,
          userAgent: v.userAgent,
        };
        setPresetDefaults(nextDefaults);
        const presets = { providers, defaults: nextDefaults };
        saveLocalPresets(presets);
        saveSettings(presets)
          .then((ok) => { if (!ok) serverPersistRef.current = false; })
          .catch((e) => showToast(t("app.toastConfigSyncFailed", { msg: e?.message ?? e })));
      }, 800);
    }
  };

  // 把 presets 持久化：服务端可用则写服务端（跨设备）；本地缓存始终作镜像同步。
  // 当前配置即默认，修改自动覆盖。
  const persistPresets = (presets: PresetsResponse) => {
    saveLocalPresets(presets);
    if (serverPersistRef.current) {
      saveSettings(presets)
        .then((ok) => { if (!ok) serverPersistRef.current = false; })
        .catch((e) => showToast(t("app.toastServerSaveFailed", { msg: e?.message ?? e })));
    }
  };

  const applyPresets = (presets: PresetsResponse, message: string) => {
    setPresetDefaults(presets.defaults);
    setProviders(presets.providers);
    persistPresets(presets);

    const currentConn = connRef.current;
    let nextConn = currentConn;
    if (currentConn.providerId !== CUSTOM_PROVIDER_ID) {
      const selected = presets.providers.find((p) => p.id === currentConn.providerId);
      nextConn = selected
        ? { ...currentConn, baseUrl: selected.baseUrl, isFullUrl: Boolean(selected.isFullUrl) }
        : { providerId: CUSTOM_PROVIDER_ID, baseUrl: "", isFullUrl: false, apiKey: currentConn.apiKey };
      setConn(nextConn);
      saveConn({ providerId: nextConn.providerId, baseUrl: nextConn.baseUrl, isFullUrl: Boolean(nextConn.isFullUrl), apiKey: nextConn.apiKey } as ConnState);
    }

    setRows(buildRows(presets.providers, nextConn.providerId));
    showToast(message);
  };

  const onPresetProvidersChange = (nextProviders: ProviderPreset[]) => {
    applyPresets({ providers: nextProviders, defaults: presetDefaults }, t("app.toastProvidersSaved"));
  };

  const onImportPresets = (presets: PresetsResponse) => {
    applyPresets(presets, t("app.toastImported"));
  };

  const onTogglePersist = (on: boolean) => {
    persistSetPersist(on);
    setPersistState(on);
    if (!on) setHistory([]); // 关闭即清内存展示（storage 已被清）
  };

  const onClearHistory = () => {
    clearHistory();
    setHistory([]);
  };

  // 更新单个协议探针（按 行 key + 协议）。
  const patchProbe = (rowKey: string, protocol: Protocol, patch: Partial<ProtocolProbe>) => {
    setRows((rs) => rs.map((r) =>
      r.key === rowKey
        ? { ...r, probes: { ...r.probes, [protocol]: { ...r.probes[protocol], ...patch } } }
        : r,
    ));
  };

  // 自动检测单行：4 协议非流式 → 通过者再探流式。返回是否有任一协议通过。
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

      // 3) 写历史：每个「模型×协议」一条（非流式结果 + 流式结论）。
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

  const onTestSelected = () => runBatch(rows.filter((r) => r.checked));
  const onTestAll = () => runBatch(rows);

  const onToggle = (key: string, checked: boolean) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, checked } : r)));
  const onToggleAll = (checked: boolean) => setRows((rs) => rs.map((r) => ({ ...r, checked })));

  const onAddModel = (model: string) => {
    setRows((rs) => {
      const existing = rs.find((r) => r.label === model);
      if (existing) {
        return rs.map((r) => (r.key === existing.key ? { ...r, checked: true, probes: freshProbes() } : r));
      }
      return [
        ...rs,
        {
          key: nextKey(),
          label: model,
          modelByProvider: {},
          custom: true,
          checked: true,
          probes: freshProbes(),
        },
      ];
    });
  };
  const onRemoveModel = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  // 批量加入模型（来自「拉取模型」弹层）：已存在则勾选，否则新增 custom 行。
  const onAddModels = (ids: string[]) => {
    setRows((rs) => {
      const next = [...rs];
      for (const id of ids) {
        const model = id.trim();
        if (!model) continue;
        const existing = next.find((r) => r.label === model);
        if (existing) {
          const idx = next.indexOf(existing);
          next[idx] = { ...existing, checked: true, probes: freshProbes() };
        } else {
          next.push({
            key: nextKey(),
            label: model,
            modelByProvider: {},
            custom: true,
            checked: true,
            probes: freshProbes(),
          });
        }
      }
      return next;
    });
  };

  // 口令门：未通过时只显示口令输入。
  if (needPassword && !authed) {
    return (
      <div class="pw-gate">
        <h1>{t("app.pwTitle")}</h1>
        <section class="panel">
          <div class="field">
            <label>{t("app.pwLabel")}</label>
            <input
              type="password"
              value={pwInput}
              onInput={(e) => setPwInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitPassword(); }}
            />
          </div>
          <div class="actions">
            <button class="primary" onClick={submitPassword}>{t("app.pwEnter")}</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div class="app">
      <header class="top">
        <h1>{t("app.title")}</h1>
        <span class="sub legend">
          <span class="pbadge success"><span class="pbadge-label">{t("app.legendProtocol")}</span></span>
          Chat·Resp·Gem·Claude
          <span class="legend-sep">·</span>
          <span class="sw green" />{t("app.legendPass")}<span class="sw red" />{t("app.legendFail")}<span class="sw blue" />{t("app.legendTesting")}
          <span class="legend-sep">·</span>
          <span class="stream-mark on">⚡</span>{t("app.legendStream")}<span class="stream-mark single">~</span>{t("app.legendSingle")}<span class="stream-mark off">⌁</span>{t("app.legendNone")}
        </span>
        <span class="spacer" />
        <LangToggle />
        <ThemeToggle />
      </header>

      <nav class="app-tabs" aria-label={t("app.navLabel")}>
        <button
          type="button"
          class={"app-tab " + (activeTab === "test" ? "active" : "")}
          aria-current={activeTab === "test" ? "page" : undefined}
          onClick={() => setActiveTab("test")}
        >
          {t("app.tabTest")}
        </button>
        <button
          type="button"
          class={"app-tab " + (activeTab === "settings" ? "active" : "")}
          aria-current={activeTab === "settings" ? "page" : undefined}
          onClick={() => setActiveTab("settings")}
        >
          {t("app.tabSettings")}
        </button>
      </nav>

      {loadErr ? (
        <section class="panel">
          <div class="status-text fail">{t("app.loadFailed", { msg: loadErr })}</div>
          <div class="actions"><button onClick={init}>{t("app.retry")}</button></div>
        </section>
      ) : null}

      {activeTab === "test" ? (
        <>
          <ConnectionPanel providers={providers} value={conn} userAgent={config.userAgent} onChange={onConnChange} onAddModels={onAddModels} onToast={showToast} />
          <ModelTable
            rows={rows}
            busy={busy}
            conn={conn}
            providerName={
              providers.find((p) => p.id === conn.providerId)?.name ??
              (conn.providerId === CUSTOM_PROVIDER_ID ? t("common.custom") : conn.providerId)
            }
            onToggle={onToggle}
            onToggleAll={onToggleAll}
            onAdd={onAddModel}
            onRemove={onRemoveModel}
            onTestSelected={onTestSelected}
            onTestAll={onTestAll}
            onLaunched={showToast}
          />
          <HistoryPanel
            entries={history}
            persist={persist}
            onTogglePersist={onTogglePersist}
            onClear={onClearHistory}
            onLaunched={showToast}
          />
        </>
      ) : (
        <>
          <ConfigPanel value={config} onChange={onConfigChange} />
          <SettingsPanel
            providers={providers}
            defaults={presetDefaults}
            busy={busy}
            onChange={onPresetProvidersChange}
            onImport={onImportPresets}
          />
        </>
      )}

      {toast ? <div class="toast">{toast}</div> : null}
    </div>
  );
}
