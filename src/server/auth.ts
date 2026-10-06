import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db";

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

// 存在しない社員IDでも同じ計算時間にして、IDの有無を推測されにくくする
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export function checkCredentials(db: Db, id: string, password: string): { ok: true; id: string } | { ok: false } {
  const row = db.prepare("SELECT id, password_hash FROM employees WHERE id = ? AND active = 1").get(id) as { id: string; password_hash: string } | undefined;
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
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

/** 連続失敗でログインを一時ロックする（社員ID単位・メモリ保持） */
export class LoginThrottle {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private max = 5, private lockMs = 5 * 60_000) {}

  lockedUntil(id: string, nowMs: number): number {
    const f = this.fails.get(id);
    return f && f.until > nowMs ? f.until : 0;
  }

  failure(id: string, nowMs: number): void {
    const f = this.fails.get(id) ?? { n: 0, until: 0 };
    f.n = f.until && f.until <= nowMs ? 1 : f.n + 1;
    f.until = f.n >= this.max ? nowMs + this.lockMs : 0;
    this.fails.set(id, f);
  }

  success(id: string): void {
    this.fails.delete(id);
  }
}
