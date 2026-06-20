import type { Balance, LookupRequest } from "./types.js";
import { withUserAgent } from "./user-agent.js";

// 余额/额度查询。各家端点 + 解析硬编码于下方注册表（参考 farion1231/cc-switch balance.rs）。
// 加新供应商只需往 BALANCE_PROVIDERS 追加一项。全程经后端代理，apiKey 不存储/打印。

const FETCH_TIMEOUT_MS = 15000;

// 数值容错：接受 number 或可解析的字符串，否则 null。
function numField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

interface BalanceProvider {
  name: string;
  match: (host: string) => boolean;
  url: string;                       // 硬编码端点（不由 baseUrl 推导）
  parse: (json: any) => Omit<Balance, "supported">;
}

const EMPTY: Omit<Balance, "supported"> = {
  remaining: null, total: null, used: null, currency: null, isValid: null,
};

export const BALANCE_PROVIDERS: BalanceProvider[] = [
  {
    name: "DeepSeek",
    match: (h) => h.includes("api.deepseek.com"),
    url: "https://api.deepseek.com/user/balance",
    parse: (j) => {
      const info = Array.isArray(j?.balance_infos) ? j.balance_infos[0] : null;
      return {
        ...EMPTY,
        remaining: numField(info?.total_balance),
        currency: typeof info?.currency === "string" ? info.currency : null,
        isValid: typeof j?.is_available === "boolean" ? j.is_available : null,
      };
    },
  },
  {
    name: "SiliconFlow",
    match: (h) => h.includes("api.siliconflow.cn"),
    url: "https://api.siliconflow.cn/v1/user/info",
    parse: (j) => ({ ...EMPTY, remaining: numField(j?.data?.totalBalance), currency: "CNY" }),
  },
  {
    name: "SiliconFlow",
    match: (h) => h.includes("api.siliconflow.com"),
    url: "https://api.siliconflow.com/v1/user/info",
    parse: (j) => ({ ...EMPTY, remaining: numField(j?.data?.totalBalance) }),
  },
  {
    name: "OpenRouter",
    match: (h) => h.includes("openrouter.ai"),
    url: "https://openrouter.ai/api/v1/credits",
    parse: (j) => {
      const total = numField(j?.data?.total_credits);
      const used = numField(j?.data?.total_usage);
      return {
        ...EMPTY,
        total, used,
        remaining: total != null && used != null ? total - used : null,
        currency: "USD",
      };
    },
  },
  {
    name: "StepFun",
    match: (h) => h.includes("api.stepfun.ai") || h.includes("api.stepfun.com"),
    url: "https://api.stepfun.com/v1/accounts",
    parse: (j) => ({ ...EMPTY, remaining: numField(j?.balance) }),
  },
  {
    name: "Novita",
    match: (h) => h.includes("api.novita.ai"),
    url: "https://api.novita.ai/v3/user/balance",
    parse: (j) => {
      const raw = numField(j?.availableBalance);
      return { ...EMPTY, remaining: raw != null ? raw / 10000 : null, currency: "USD" };
    },
  },
];

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ""; }
}

function providerFor(baseUrl: string): BalanceProvider | null {
  const host = hostOf(baseUrl);
  if (!host) return null;
  return BALANCE_PROVIDERS.find((p) => p.match(host)) ?? null;
}

async function fetchWithTimeout(url: string, apiKey: string, userAgent?: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      headers: withUserAgent({ authorization: `Bearer ${apiKey}` }, userAgent),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`请求超时 (${FETCH_TIMEOUT_MS}ms)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const UNSUPPORTED: Balance = {
  supported: false, remaining: null, total: null, used: null, currency: null, isValid: null,
};

export async function fetchBalance(req: LookupRequest): Promise<Balance> {
  const provider = providerFor(req.baseUrl);
  if (!provider) return UNSUPPORTED;

  const res = await fetchWithTimeout(provider.url, req.apiKey, req.userAgent);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json().catch(() => null);
  return { supported: true, ...provider.parse(json) };
}

// 本次余额查询会真正请求的 URL（用于 allowlist 校验）；不支持的 host 返回空。
export function balanceTargetUrl(baseUrl: string): string | null {
  return providerFor(baseUrl)?.url ?? null;
}
