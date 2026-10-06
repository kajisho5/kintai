import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db";

const KEYLEN = 64;
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const format = (salt: Buffer, hash: Buffer) => `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;

/**
 * パスワードのハッシュ化。scrypt は1回あたり数十ミリ秒かかるため、リクエスト処理では
 * 必ず非同期版を使う（同期版だと、他の全社のリクエストがその間止まる）。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return format(salt, await scryptAsync(password, salt, KEYLEN));
}

/** 同期版。デモデータの投入（起動前の一括処理）専用 */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  return format(salt, scryptSync(password, salt, KEYLEN));
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

// 存在しない社員IDでも同じ計算時間にして、IDの有無を推測されにくくする
const DUMMY_HASH = hashPasswordSync("dummy-password-for-timing");

/** 存在しない企業ID・社員IDでも同じ時間をかけて、存在の有無を推測されにくくする */
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

export async function checkCredentials(db: Db, id: string, password: string): Promise<{ ok: true; id: string } | { ok: false }> {
  const row = db.prepare("SELECT id, password_hash FROM employees WHERE id = ? AND active = 1").get(id) as { id: string; password_hash: string } | undefined;
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok ? { ok: true, id: row.id } : { ok: false };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function createSession(db: Db, empId: string, nowMs: number, ttlMs: number): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowMs);
  db.prepare("INSERT INTO sessions (token_hash, emp_id, expires_at) VALUES (?, ?, ?)").run(sha(token), empId, nowMs + ttlMs);
  return token;
}

export function sessionEmployee(db: Db, token: string | undefined, nowMs: number): string | undefined {
  if (!token) return undefined;
  const row = db
    .prepare("SELECT s.emp_id AS id FROM sessions s JOIN employees e ON e.id = s.emp_id WHERE s.token_hash = ? AND s.expires_at > ? AND e.active = 1")
    .get(sha(token), nowMs) as { id: string } | undefined;
  return row?.id;
}

export function destroySession(db: Db, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

/** 連続失敗でログインを一時ロックする（キー単位・メモリ保持。古い記録は自動で削除する） */
export class LoginThrottle {
  private fails = new Map<string, { n: number; until: number; last: number }>();
  constructor(private max = 5, private lockMs = 5 * 60_000) {}

  lockedUntil(key: string, nowMs: number): number {
    const f = this.fails.get(key);
    return f && f.until > nowMs ? f.until : 0;
  }

  failure(key: string, nowMs: number): void {
    const f = this.fails.get(key) ?? { n: 0, until: 0, last: nowMs };
    f.n = f.until && f.until <= nowMs ? 1 : f.n + 1;
    f.until = f.n >= this.max ? nowMs + this.lockMs : 0;
    f.last = nowMs;
    this.fails.set(key, f);
    if (this.fails.size > 10_000) this.gc(nowMs);
  }

  success(key: string): void {
    this.fails.delete(key);
  }

  /** ロックが解けて一定時間たった記録を捨てる（キーが増え続けないように） */
  private gc(nowMs: number): void {
    for (const [k, f] of this.fails) if (f.until <= nowMs && nowMs - f.last > this.lockMs * 2) this.fails.delete(k);
  }
}
