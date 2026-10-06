import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 二段階認証（TOTP, RFC 6238）。外部のライブラリは使わず、Node 標準の暗号機能だけで実装する。 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("不正なBase32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = (): string => base32Encode(randomBytes(20));

const STEP_SECONDS = 30;
export const stepOf = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** その時間ステップの6桁のコード（RFC 4226 の動的切り詰め） */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * コードを検証する。前後1ステップ（約30秒の時計のずれ）を許す。
 * 合っていれば、そのステップを返す。lastStep 以前のステップ（使用済み）は、再利用として拒否する。
 */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep = 0): number | undefined {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return undefined;
  const now = stepOf(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (step > lastStep && same(totpAt(secret, step), c)) return step;
  }
  return undefined;
}

export const otpauthUri = (issuer: string, account: string, secret: string): string =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// ---- 回復コード（スマートフォンを失くしたとき用。1回限り） ----

const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const RECOVERY_COUNT = 8;

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]!).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const normalizeRecovery = (s: string): string => s.toUpperCase().replace(/[^0-9A-Z]/g, "");
export const hashRecovery = (code: string): string => createHash("sha256").update(`recovery:${normalizeRecovery(code)}`).digest("hex");

// ---- 秘密鍵の暗号化（DBが漏れても、すぐには使えないように） ----

/** 環境変数 SECRET_KEY（任意の文字列）から鍵を作る。未設定なら暗号化せず保存する（本番では設定すること） */
const keyOf = (secretKey: string | undefined): Buffer | undefined => (secretKey ? createHash("sha256").update(`kintai-totp:${secretKey}`).digest() : undefined);

export function sealSecret(secret: string, secretKey = process.env.SECRET_KEY): string {
  const key = keyOf(secretKey);
  if (!key) return `plain:${secret}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

export function openSecret(stored: string, secretKey = process.env.SECRET_KEY): string {
  if (stored.startsWith("plain:")) return stored.slice(6);
  const [v, iv, tag, ct] = stored.split(":");
  const key = keyOf(secretKey);
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("二段階認証の秘密鍵の形式が正しくありません");
  if (!key) throw new Error("SECRET_KEY が設定されていないため、二段階認証の秘密鍵を読み出せません");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
