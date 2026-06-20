// 应用层 SSRF 兜底（可选，默认关闭）。设 BLOCK_PRIVATE_HOSTS=1 后启用。
// 注意：本工具的合法用途包含测试本地/内网端点（如 Ollama），故默认不拦截；
// 仅在部署到不可信多租户环境时按需开启。这是防火墙脚本（deploy/firewall-egress.sh）
// 之外的应用层补充——它只能识别「字面 IP / 明显本地名」，无法防 DNS rebinding，
// 真正的网络隔离仍应以防火墙为准。

// IPv4 私有 / 环回 / 链路本地 / 共享(CGNAT) / 云元数据 段。
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 环回
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（含 169.254.169.254 元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

// IPv6 环回 / 链路本地 / 唯一本地(ULA) / IPv4 映射的私有地址。
function isPrivateIpv6(host: string): boolean {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.toLowerCase();
  if (h === "::1" || h === "::") return true; // 环回 / 未指定
  if (h.startsWith("fe80")) return true; // 链路本地
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // 唯一本地 fc00::/7
  // IPv4 映射 ::ffff:a.b.c.d → 复用 IPv4 判定。
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

// 判断目标 host 是否属于私有/本地范围（字面 IP 或常见本地名）。
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true; // 空 host 视为不安全
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":") || host.startsWith("[")) return isPrivateIpv6(host);
  return false;
}

// 从 URL 取 host 并判定；非法 URL 视为不安全（拦截）。
export function isPrivateUrl(rawUrl: string): boolean {
  try {
    return isPrivateHost(new URL(rawUrl).hostname);
  } catch {
    return true;
  }
}
