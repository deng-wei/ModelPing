import type { ConfigState, ConnState, HistoryEntry } from "./types.js";

// Legacy localStorage keys. New versions persist sensitive working state only
// through encrypted server-side private-state; these keys are read once for
// migration and then removed.
const K_HISTORY = "llm-test:history";
const K_PERSIST = "llm-test:persist"; // 历史是否持久化（"1"/"0"）
const K_CONN = "llm-test:conn";       // 上次连接配置（含 key，仅本机）
const K_CONFIG = "llm-test:config";   // 上次参数配置

const MAX_HISTORY = 200; // 历史上限，超出丢弃最旧。

export interface LegacyPrivateState {
  historyPersist?: boolean;
  history?: HistoryEntry[];
  conn?: ConnState | null;
  config?: Partial<ConfigState> | null;
}

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function removeLegacyKeys(storage: Storage): void {
  for (const key of [K_HISTORY, K_PERSIST, K_CONN, K_CONFIG]) {
    storage.removeItem(key);
  }
}

export function migrateLegacyPrivateState(storage: Storage = localStorage): LegacyPrivateState {
  const rawHistory = readJson<unknown>(storage, K_HISTORY);
  const history = Array.isArray(rawHistory) ? rawHistory.slice(0, MAX_HISTORY) as HistoryEntry[] : undefined;
  const conn = readJson<ConnState>(storage, K_CONN);
  const config = readJson<Partial<ConfigState>>(storage, K_CONFIG);
  const persistRaw = storage.getItem(K_PERSIST);
  const migrated: LegacyPrivateState = {};
  if (persistRaw !== null) migrated.historyPersist = persistRaw !== "0";
  if (history) migrated.history = history;
  if (conn && typeof conn === "object") migrated.conn = conn;
  if (config && typeof config === "object") migrated.config = config;
  removeLegacyKeys(storage);
  return migrated;
}

// ---------- 工具：key 掩码 ----------
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(6)}${key.slice(-4)}`;
}
