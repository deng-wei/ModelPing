// 轻量对称加密（AES-256-GCM），用于状态列表（含 apiKey）落盘前加密。
// 零依赖：用 WebCrypto（globalThis.crypto.subtle），Node 20+ / Workers / Vercel 均可用。
// 密钥由 STATUS_SECRET || APP_PASSWORD 经 PBKDF2(SHA-256) 派生；每次加密用随机 salt+iv。
// 落盘格式：JSON { v:1, salt, iv, ct }（均 base64）。

const PBKDF2_ITERS = 120_000;
const SALT_LEN = 16;
const IV_LEN = 12;

interface EncBlob {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// 加密明文，返回可直接落盘的 JSON 字符串。
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(secret, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  const blob: EncBlob = { v: 1, salt: b64encode(salt), iv: b64encode(iv), ct: b64encode(ct) };
  return JSON.stringify(blob);
}

// 解密 encrypt() 产出的 JSON 字符串。密钥/密文不匹配会抛出（GCM 校验失败）。
export async function decrypt(blobStr: string, secret: string): Promise<string> {
  const blob = JSON.parse(blobStr) as EncBlob;
  if (blob?.v !== 1) throw new Error("不支持的加密格式");
  const key = await deriveKey(secret, b64decode(blob.salt));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(blob.iv) as BufferSource },
    key,
    b64decode(blob.ct) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}
