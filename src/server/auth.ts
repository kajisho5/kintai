import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Db } from "./db";

const KEYLEN = 64;
/** 現在のパラメータ（コスト N = 2^15、メモリ 32MiB）。ハッシュ文字列に入れるので、将来、上げても、保存済みのハッシュは検証できる */
const CURRENT_LOG2_N = 15;
const MAXMEM = 128 * 1024 * 1024;

const scryptAsync = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password, salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));

const format = (log2n: number, salt: Buffer, hash: Buffer) => `scrypt2$${log2n}$${salt.toString("base64url")}$${hash.toString("base64url")}`;

/**
 * パスワードのハッシュ化。scrypt は1回あたり数十〜百数十ミリ秒かかるため、リクエスト処理では
 * 必ず非同期版を使う（同期版だと、他の全社のリクエストがその間止まる）。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return format(CURRENT_LOG2_N, salt, await scryptAsync(password, salt, KEYLEN, { N: 2 ** CURRENT_LOG2_N, r: 8, p: 1, maxmem: MAXMEM }));
}

/**
 * 一時パスワード（ランダムに生成した、推測できない値。初回ログインで本人が変更する）のハッシュ化。
 * 大量の社員を一度に登録するとき、計算が全社のログインを待たせないよう、コストを下げる（ログインに成功したときに、通常のコストで作り直される）。
 */
export async function hashTemporaryPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return format(12, salt, await scryptAsync(password, salt, KEYLEN, { N: 2 ** 12, r: 8, p: 1, maxmem: MAXMEM }));
}

/** 同期版。デモデータの投入（起動前の一括処理）専用 */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  return format(CURRENT_LOG2_N, salt, scryptSync(password, salt, KEYLEN, { N: 2 ** CURRENT_LOG2_N, r: 8, p: 1, maxmem: MAXMEM }));
}

/** 保存済みのハッシュを、今のパラメータで作り直す必要があるか（古い形式、またはコストが低い） */
export const needsRehash = (stored: string): boolean => {
  const [scheme, log2n] = stored.split("$");
  return !(scheme === "scrypt2" && Number(log2n) >= CURRENT_LOG2_N);
};

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  let log2n = 14; // 古い形式（scrypt$salt$hash）は、Node の既定（N=16384）
  let saltB64: string | undefined;
  let hashB64: string | undefined;
  if (parts[0] === "scrypt2") {
    log2n = Number(parts[1]);
    [, , saltB64, hashB64] = parts;
  } else if (parts[0] === "scrypt") {
    [, saltB64, hashB64] = parts;
  } else return false;
  if (!saltB64 || !hashB64 || !Number.isInteger(log2n) || log2n < 12 || log2n > 17) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64url"), expected.length, { N: 2 ** log2n, r: 8, p: 1, maxmem: MAXMEM });
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
  if (row && ok && needsRehash(row.password_hash)) {
    // 古い形式・低いコストのハッシュは、ログインできたときに、今のパラメータで作り直す（失敗しても、ログインは止めない）
    try {
      db.prepare("UPDATE employees SET password_hash = ? WHERE id = ? AND password_hash = ?").run(await hashPassword(password), row.id, row.password_hash);
    } catch {
      /* 次回に作り直す */
    }
  }
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
  /** windowMs: この時間のあいだ、失敗がなければ、それまでの失敗の回数は忘れる（古い失敗が、いつまでも積み上がらないように） */
  constructor(private max = 5, private lockMs = 5 * 60_000, private windowMs = lockMs) {}

  lockedUntil(key: string, nowMs: number): number {
    const f = this.fails.get(key);
    return f && f.until > nowMs ? f.until : 0;
  }

  failure(key: string, nowMs: number): void {
    const f = this.fails.get(key) ?? { n: 0, until: 0, last: nowMs };
    f.n = (f.until && f.until <= nowMs) || nowMs - f.last > this.windowMs ? 1 : f.n + 1;
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

/** ICカードの番号を比べやすい形にそろえる（読み取り機によって、区切りや大文字小文字が違うため）。使えない形なら undefined */
export function normalizeCard(raw: string): string | undefined {
  const s = raw.trim().replace(/[\s:_-]/g, "");
  return /^[0-9A-Za-z]{6,64}$/.test(s) ? s.toUpperCase() : undefined;
}

/** カード番号の保存用の値（会社ごとに異なる。カード番号そのものは保存しない） */
export const cardHash = (tenantId: string, normalized: string): string => createHash("sha256").update(`card:${tenantId}:${normalized}`).digest("hex");

/** 端末の印（Cookie）を発行する。ログインに成功した端末に渡す */
export function issueDevice(db: Db, empId: string, nowMs: number): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM trusted_devices WHERE created_at < ?").run(nowMs - DEVICE_TTL_MS);
  db.prepare("INSERT INTO trusted_devices (token_hash, emp_id, created_at) VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), empId, nowMs);
  return token;
}

export const DEVICE_TTL_MS = 180 * 86400_000;

/** 端末の印が、この社員のものとして有効か（アカウントのロック中でも、パスワードの確認に進めるかの判断に使う） */
export function deviceKnown(db: Db, token: string | undefined, empId: string, nowMs: number): boolean {
  if (!token) return false;
  return !!db.prepare("SELECT 1 FROM trusted_devices WHERE token_hash = ? AND emp_id = ? AND created_at > ?").get(createHash("sha256").update(token).digest("hex"), empId, nowMs - DEVICE_TTL_MS);
}

/** パスワードの変更・再設定・退職のとき、その社員の端末の印をすべて無効にする */
export function forgetDevices(db: Db, empId: string): void {
  db.prepare("DELETE FROM trusted_devices WHERE emp_id = ?").run(empId);
}
