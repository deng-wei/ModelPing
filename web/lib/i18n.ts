// 语言偏好：en / zh。偏好存 localStorage，默认英文。
// 采用模块级订阅：setLang 通知所有 useI18n 订阅者重渲染，并同步 <html lang> 与文档标题。
import { useEffect, useState } from "preact/hooks";
import { en } from "./locales/en.js";
import { zh } from "./locales/zh.js";

export type Lang = "en" | "zh";

const KEY = "llm-test:lang";

const DICTS: Record<Lang, Record<string, unknown>> = { en, zh };
const HTML_LANG: Record<Lang, string> = { en: "en", zh: "zh-CN" };

let current: Lang = readLang();
const listeners = new Set<() => void>();

function readLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    return v === "zh" ? "zh" : "en"; // 默认英文
  } catch {
    return "en";
  }
}

// 按 "a.b.c" 路径取值。
function lookup(dict: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

// 翻译：当前语言 → 英文兜底 → key 原样。支持 {name} 占位符插值。
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const s = lookup(DICTS[lang], key) ?? lookup(DICTS.en, key) ?? key;
  if (!params) return s;
  // 单次扫描替换所有 {name} 占位符，避免逐 param 重新编译正则。
  return s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

export function getLang(): Lang {
  return current;
}

// 应用语言到 <html lang> 与文档标题。
function apply(lang: Lang): void {
  document.documentElement.lang = HTML_LANG[lang];
  document.title = translate(lang, "app.docTitle");
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* 忽略写入失败 */
  }
  apply(lang);
  listeners.forEach((fn) => fn());
}

// 初始化：应用当前偏好到 <html lang> 与标题。
export function initLang(): Lang {
  apply(current);
  return current;
}

export function useI18n() {
  const [lang, setLangState] = useState<Lang>(current);

  useEffect(() => {
    const fn = () => setLangState(current);
    listeners.add(fn);
    fn(); // 订阅时对齐最新值
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  return { lang, setLang, t };
}
