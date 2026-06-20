import type { HistoryEntry } from "./types.js";

// localStorage 键名。
const K_HISTORY = "llm-test:history";
const K_PERSIST = "llm-test:persist"; // 历史是否持久化（"1"/"0"）
const K_CONN = "llm-test:conn";       // 上次连接配置（含 key，仅本机）
const K_CONFIG = "llm-test:config";   // 上次参数配置

const MAX_HISTORY = 200; // 历史上限，超出丢弃最旧。

// ---------- 持久化开关 ----------
export function getPersist(): boolean {
  return localStorage.getItem(K_PERSIST) !== "0"; // 缺省开启
}

export function setPersist(on: boolean): void {
  localStorage.setItem(K_PERSIST, on ? "1" : "0");
  if (!on) localStorage.removeItem(K_HISTORY); // 关闭时清掉已存历史
}

// ---------- 历史记录 ----------
export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(K_HISTORY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 追加一条历史并返回新数组。持久化关闭时只在内存层（由调用方持有），不写盘。
export function appendHistory(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...list].slice(0, MAX_HISTORY);
  if (getPersist()) {
    try {
      localStorage.setItem(K_HISTORY, JSON.stringify(next));
    } catch {
      // 配额超限等，忽略写入失败，内存仍保留。
    }
  }
  return next;
}

export function clearHistory(): void {
  localStorage.removeItem(K_HISTORY);
}

// ---------- 连接配置（含 key，仅本机存储） ----------
// 自动检测后不再要求用户选协议，protocol 仅为旧数据兼容保留（可选）。
export interface ConnState {
  providerId: string;
  baseUrl: string;
  isFullUrl?: boolean;
  apiKey: string;
  protocol?: string;
}

export function loadConn(): ConnState | null {
  try {
    const raw = localStorage.getItem(K_CONN);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveConn(c: ConnState): void {
  try {
    localStorage.setItem(K_CONN, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

// ---------- 参数配置 ----------
export interface ConfigState {
  input: string;
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  userAgent: string;
}

export function loadConfig(): Partial<ConfigState> | null {
  try {
    const raw = localStorage.getItem(K_CONFIG);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveConfig(c: ConfigState): void {
  try {
    localStorage.setItem(K_CONFIG, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

// ---------- 工具：key 掩码 ----------
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(6)}${key.slice(-4)}`;
}
