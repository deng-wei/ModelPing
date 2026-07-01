import { useEffect, useRef, useState } from "preact/hooks";
import type { ConfigState, Defaults, HistoryEntry, PresetsResponse, PrivateState, ProviderPreset, StatusEntry } from "../lib/types.js";
import { emptyPrivateState, fetchHealth, fetchPresets, fetchPrivateState, fetchSettings, savePrivateState, saveSettings, setAppPassword } from "../lib/api.js";
import {
  CUSTOM_PROVIDER_ID,
  FALLBACK_DEFAULTS,
  normalizeConcurrency,
  loadLocalPresets, saveLocalPresets,
} from "../lib/presets.js";
import { initTheme } from "../lib/theme.js";
import { ConnectionPanel, type ConnValue } from "./ConnectionPanel.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { ModelTable, freshProbes, type ModelRow } from "./ModelTable.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { LangToggle } from "./LangToggle.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { StatusPanel } from "./StatusPanel.js";
import { initLang, useI18n } from "../lib/i18n.js";
import { useDetect } from "./useDetect.js";
import { migrateLegacyPrivateState } from "../lib/storage.js";

let rowSeq = 0;
const nextKey = () => `r${++rowSeq}`;
let statusSeq = 0;
const nextStatusId = () => `s${Date.now()}-${++statusSeq}`;
const MAX_HISTORY = 200;
type PrivateStateScope = "full" | "config" | "none";

type StatusDraft = Omit<StatusEntry, "id">;

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
  const { t, lang } = useI18n();
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [presetDefaults, setPresetDefaults] = useState<Defaults>(FALLBACK_DEFAULTS);
  const [activeTab, setActiveTab] = useState<"test" | "status" | "settings">("test");
  const [conn, setConn] = useState<ConnValue>({ providerId: CUSTOM_PROVIDER_ID, baseUrl: "", isFullUrl: false, apiKey: "" });
  const [config, setConfig] = useState<ConfigState>({ input: "", timeoutMs: 30000, maxRetries: 1, maxTokens: 512, userAgent: "", concurrency: 2 });
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [statusEntries, setStatusEntries] = useState<StatusEntry[]>([]);
  const [statusPersisted, setStatusPersisted] = useState(true);
  const [persist, setPersistState] = useState<boolean>(true);
  const [toast, setToast] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [securityWarn, setSecurityWarn] = useState(false);

  // 口令门：need=后端要求口令，authed=已通过。
  const [needPassword, setNeedPassword] = useState(false);
  const [authed, setAuthed] = useState(true);
  const [pwInput, setPwInput] = useState("");

  // 服务端是否启用了持久化（presets 跨设备共享）。null=未知，初始化时探测。
  const serverPersistRef = useRef<boolean>(false);
  const statusPersistedRef = useRef(true);
  const privatePersistRef = useRef(false);
  const privateStateScopeRef = useRef<PrivateStateScope>("none");
  const privateSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPrivateSaveRef = useRef<string>("");
  const privateStateRef = useRef<PrivateState>(emptyPrivateState());
  // ConfigPanel 参数 → defaults 同步到后端的防抖句柄。
  const configSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 当前语言对应的默认输入文本；语言切换时若用户未自定义则跟随更新。
  const defaultInputRef = useRef(t("config.defaultInput"));

  const historyRef = useRef(history);
  historyRef.current = history;
  const statusEntriesRef = useRef(statusEntries);
  statusEntriesRef.current = statusEntries;

  // 当前连接/参数的 ref，供并发探测闭包读取最新值。
  const connRef = useRef(conn);
  connRef.current = conn;
  const configRef = useRef(config);
  configRef.current = config;

  const syncPrivateRef = (patch: Partial<PrivateState>) => {
    privateStateRef.current = {
      ...privateStateRef.current,
      ...patch,
      updatedAt: Date.now(),
    };
  };

  const schedulePrivateSave = () => {
    if (!privatePersistRef.current) return;
    if (privateSaveRef.current) clearTimeout(privateSaveRef.current);
    privateSaveRef.current = setTimeout(() => {
      const scope = privateStateScopeRef.current;
      const state = scope === "config"
        ? { ...privateStateRef.current, historyPersist: false, history: [], updatedAt: privateStateRef.current.updatedAt }
        : privateStateRef.current;
      const serialized = JSON.stringify(state);
      if (serialized === lastPrivateSaveRef.current) return;
      savePrivateState(state)
        .then((ok) => {
          if (!ok) {
            privatePersistRef.current = false;
            statusPersistedRef.current = false;
            setStatusPersisted(false);
            showToast(t("app.privateStateUnavailable"));
          } else {
            lastPrivateSaveRef.current = serialized;
          }
        })
        .catch((e) => showToast(t("app.privateStateSaveFailed", { msg: e?.message ?? e })));
    }, 2000);
  };

  const persistPrivateState = (patch: Partial<PrivateState>) => {
    syncPrivateRef(patch);
    schedulePrivateSave();
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  const isLocalOrigin = () => {
    const host = window.location.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  };

  // 模型检测引擎（单行 4 协议探测 + 并发池）已抽到 useDetect；busy 由其持有。
  const { busy, progress, runBatch, cancelBatch } = useDetect({
    connRef,
    configRef,
    providers,
    setRows,
    historyRef,
    addHistoryEntry: (entry) => {
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, MAX_HISTORY);
        historyRef.current = next;
        if (privateStateRef.current.historyPersist && privateStateScopeRef.current === "full") persistPrivateState({ history: next });
        return next;
      });
    },
    showToast,
  });

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
      const security = health.security;
      const scope = health.persistence?.privateState ? health.persistence.privateStateScope : "none";
      privateStateScopeRef.current = scope;
      setSecurityWarn(Boolean(security && !isLocalOrigin() && (!security.hasPassword || security.shouldWarnOpenProxy)));
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
      const privateState = await fetchPrivateState();
      const privateCanPersist = privateState !== null;
      privatePersistRef.current = privateCanPersist;
      statusPersistedRef.current = privateCanPersist;
      setStatusPersisted(privateCanPersist);
      const legacy = migrateLegacyPrivateState();
      const historyCanPersist = scope === "full";
      const mergedPrivateState: PrivateState = {
        ...(privateState ?? emptyPrivateState()),
        historyPersist: historyCanPersist ? (privateState?.historyPersist ?? legacy.historyPersist ?? true) : false,
        history: historyCanPersist
          ? (privateState?.history?.length ? privateState.history : (legacy.history ?? []))
          : [],
        conn: privateState?.conn ?? legacy.conn ?? null,
        config: privateState?.config ?? legacy.config ?? null,
        statusEntries: privateState?.statusEntries ?? [],
      };
      privateStateRef.current = mergedPrivateState;
      lastPrivateSaveRef.current = JSON.stringify(scope === "config" ? { ...mergedPrivateState, historyPersist: false, history: [] } : mergedPrivateState);
      if (privateCanPersist && (legacy.historyPersist !== undefined || legacy.history || legacy.conn || legacy.config)) {
        syncPrivateRef(mergedPrivateState);
        schedulePrivateSave();
      }
      // 服务端可用时，把结果回写本地作镜像缓存（离线/失败时仍可用）。
      if (serverPresets) saveLocalPresets(serverPresets);
      const { providers: provs, defaults: defs } = activePresets;
      setPresetDefaults(defs);
      setProviders(provs);
      setHistory(mergedPrivateState.history);
      setPersistState(mergedPrivateState.historyPersist);
      setStatusEntries(mergedPrivateState.statusEntries);

      // 恢复参数配置
      const savedCfg = mergedPrivateState.config;
      const cfg: ConfigState = {
        input: savedCfg?.input ?? defaultInputRef.current,
        timeoutMs: savedCfg?.timeoutMs ?? defs.timeoutMs,
        maxRetries: savedCfg?.maxRetries ?? defs.maxRetries,
        maxTokens: savedCfg?.maxTokens ?? defs.maxTokens,
        userAgent: savedCfg?.userAgent ?? defs.userAgent ?? "",
        concurrency: normalizeConcurrency(savedCfg?.concurrency ?? defs.concurrency),
      };
      setConfig(cfg);

      // 恢复连接字段（含 key），但供应商始终默认「自定义」。
      const savedConn = mergedPrivateState.conn;
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
    // 仅在挂载时初始化一次（init 引用每渲染都变，故有意省略依赖）。
    init();
  }, []);

  // 语言切换时，若输入文本仍为默认值（用户未自定义）则跟随语言更新。
  useEffect(() => {
    const newDefault = t("config.defaultInput");
    setConfig((prev) => {
      if (prev.input === defaultInputRef.current && prev.input !== newDefault) {
        defaultInputRef.current = newDefault;
        return { ...prev, input: newDefault };
      }
      defaultInputRef.current = newDefault;
      return prev;
    });
    // t 的取值仅随 lang 变化，故依赖仅需 lang。
  }, [lang]);

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
    persistPrivateState({ conn: { providerId: v.providerId, baseUrl: v.baseUrl, isFullUrl: Boolean(v.isFullUrl), apiKey: v.apiKey } });
    if (providerChanged) setRows((rs) => selectRowsForProvider(rs, v.providerId));
  };

  const onConfigChange = (v: ConfigState) => {
    const nextConfig = { ...v, concurrency: normalizeConcurrency(v.concurrency) };
    setConfig(nextConfig);
    persistPrivateState({ config: nextConfig });
    // 参数当默认值同步到后端 defaults（防抖，避免逐字输入狂发请求）。
    if (serverPersistRef.current) {
      if (configSyncRef.current) clearTimeout(configSyncRef.current);
      configSyncRef.current = setTimeout(() => {
        const nextDefaults: Defaults = {
          input: nextConfig.input,
          stream: presetDefaults.stream,
          timeoutMs: nextConfig.timeoutMs,
          maxRetries: nextConfig.maxRetries,
          maxTokens: nextConfig.maxTokens,
          userAgent: nextConfig.userAgent,
          concurrency: nextConfig.concurrency,
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
      persistPrivateState({ conn: { providerId: nextConn.providerId, baseUrl: nextConn.baseUrl, isFullUrl: Boolean(nextConn.isFullUrl), apiKey: nextConn.apiKey } });
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
    if (privateStateScopeRef.current !== "full") {
      setPersistState(false);
      showToast(t("app.privateStateUnavailable"));
      return;
    }
    setPersistState(on);
    if (!on) {
      setHistory([]);
      historyRef.current = [];
      persistPrivateState({ historyPersist: false, history: [] });
    } else {
      persistPrivateState({ historyPersist: true, history: historyRef.current });
    }
  };

  const onClearHistory = () => {
    setHistory([]);
    historyRef.current = [];
    persistPrivateState({ history: [] });
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

  const statusKey = (entry: Pick<StatusEntry, "baseUrl" | "protocol" | "model">) =>
    `${entry.baseUrl.trim()}|${entry.protocol}|${entry.model.trim()}`;

  const onAddToStatus = (drafts: StatusDraft[]) => {
    const clean = drafts.filter((entry) => entry.baseUrl.trim() && entry.apiKey.trim() && entry.model.trim());
    if (clean.length === 0) return;
    const byKey = new Map<string, StatusEntry>();
    for (const entry of statusEntriesRef.current) byKey.set(statusKey(entry), entry);
    let changed = false;
    for (const draft of clean) {
      const key = statusKey(draft);
      const existing = byKey.get(key);
      if (existing) {
        byKey.set(key, { ...existing, ...draft });
      } else {
        byKey.set(key, { ...draft, id: nextStatusId() });
      }
      changed = true;
    }
    if (!changed) return;
    const next = [...byKey.values()];
    setStatusEntries(next);
    persistPrivateState({ statusEntries: next });
    showToast(t("status.added", { count: clean.length }));
  };

  const onDeleteStatus = (ids: string[]) => {
    const idSet = new Set(ids);
    const next = statusEntriesRef.current.filter((entry) => !idSet.has(entry.id));
    setStatusEntries(next);
    persistPrivateState({ statusEntries: next });
    showToast(t("status.deleted", { count: ids.length }));
  };

  const onGotoStatusTest = (entry: StatusEntry) => {
    setActiveTab("test");
    onConnChange({
      providerId: CUSTOM_PROVIDER_ID,
      baseUrl: entry.baseUrl,
      isFullUrl: Boolean(entry.isFullUrl),
      apiKey: entry.apiKey,
    });
    onAddModel(entry.model);
  };

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
        <button
          type="button"
          class={"app-tab " + (activeTab === "status" ? "active" : "")}
          aria-current={activeTab === "status" ? "page" : undefined}
          onClick={() => setActiveTab("status")}
        >
          {t("app.tabStatus")}
        </button>
      </nav>

      {loadErr ? (
        <section class="panel">
          <div class="status-text fail">{t("app.loadFailed", { msg: loadErr })}</div>
          <div class="actions"><button onClick={init}>{t("app.retry")}</button></div>
        </section>
      ) : null}

      {securityWarn ? (
        <section class="security-warning" role="status">
          <strong>{t("app.securityWarningTitle")}</strong>
          <span>{t("app.securityWarningBody")}</span>
        </section>
      ) : null}

      {activeTab === "test" ? (
        <>
          <ConnectionPanel providers={providers} value={conn} userAgent={config.userAgent} onChange={onConnChange} onAddModels={onAddModels} onToast={showToast} />
          <ModelTable
            rows={rows}
            busy={busy}
            progress={progress}
            conn={conn}
            userAgent={config.userAgent}
            providerName={
              providers.find((p) => p.id === conn.providerId)?.name ??
              (conn.providerId === CUSTOM_PROVIDER_ID ? t("common.custom") : conn.providerId)
            }
            onToggle={onToggle}
            onToggleAll={onToggleAll}
            onAdd={onAddModel}
            onRemove={onRemoveModel}
            onTestSelected={onTestSelected}
            onCancel={cancelBatch}
            onTestAll={onTestAll}
            onAddToStatus={onAddToStatus}
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
      ) : activeTab === "status" ? (
        <StatusPanel
          entries={statusEntries}
          persisted={statusPersisted}
          onDelete={onDeleteStatus}
          onGotoTest={onGotoStatusTest}
          onLaunched={showToast}
        />
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
