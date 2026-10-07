import { Hono, type Context } from "hono";
import { z } from "zod";
import type { TwoFactorSetup } from "../../domain";
import { BRAND } from "../../brand";
import { checkCredentials, LoginThrottle } from "../auth";
import { ApiError, parse, type Env } from "../context";
import { audit, type Db } from "../db";
import { RateLimiter } from "../ratelimit";
import { getSetting } from "../repo";
import { hashRecovery, newRecoveryCodes, newSecret, openSecret, otpauthUri, sealSecret, verifyTotp } from "../totp";
import type { Deps } from "./auth";

interface Row {
  s: string | null;
  last: number;
  rec: string | null;
}

export const hasTotp = (db: Db, empId: string): boolean => db.prepare("SELECT 1 FROM employees WHERE id = ? AND totp_enabled_at IS NOT NULL").get(empId) !== undefined;

/**
 * 二段階目の確認（認証アプリのコード、または回復コード）。合っていれば true。
 * 認証アプリのコードは、使用済みのステップの再利用を拒否する。回復コードは1回限りで、使うと消える。
 */
export function checkSecondFactor(db: Db, empId: string, code: string, nowMs: number): boolean {
  const row = db.prepare("SELECT totp_secret AS s, totp_last_step AS last, totp_recovery AS rec FROM employees WHERE id = ? AND totp_enabled_at IS NOT NULL").get(empId) as Row | undefined;
  if (!row?.s) return false;
  const step = verifyTotp(openSecret(row.s), code, nowMs, row.last);
  if (step !== undefined) {
    // 同時に同じコードで確認された場合に、片方だけが通るよう、更新が効いたときだけ成功にする
    return db.prepare("UPDATE employees SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, empId, step).changes > 0;
  }
  const hashes = row.rec ? (JSON.parse(row.rec) as string[]) : [];
  const h = hashRecovery(code);
  if (!hashes.includes(h)) return false;
  const rest = hashes.filter((x) => x !== h);
  const r = db.prepare("UPDATE employees SET totp_recovery = ? WHERE id = ? AND totp_recovery = ?").run(JSON.stringify(rest), empId, row.rec!);
  if (r.changes === 0) return false;
  audit(db, nowMs, empId, "totp_recovery_used", { remaining: rest.length });
  return true;
}

/** 二段階認証の設定・解除（ログイン後。自分の分だけ） */
export function twoFactorRoutes(_deps: Deps): Hono<Env> {
  const app = new Hono<Env>();
  const limit = new RateLimiter(10, 10 * 60_000);
  const setupThrottle = new LoginThrottle(5, 5 * 60_000);

  const guard = (c: Context<Env>) => {
    const key = `${c.get("tenant").id}/${c.get("me").id}`;
    const now = c.get("clock").now().ts;
    if (limit.blocked(key, now)) throw new ApiError(429, "操作が多すぎます。しばらくしてからお試しください");
    limit.record(key, now);
    return now;
  };

  app.get("/api/auth/2fa", (c) => {
    const me = c.get("me");
    return c.json({ enabled: hasTotp(c.get("db"), me.id), required: me.role === "admin" && getSetting(c.get("db"), "require_2fa", "0") === "1" });
  });

  app.post("/api/auth/2fa/setup", async (c) => {
    const me = c.get("me");
    const db = c.get("db");
    const now = guard(c);
    // セッションを奪われても、第三者が二段階認証を登録して本人を締め出せないよう、パスワードをもう一度確認する（総当たりは、変更時と同じ制限で防ぐ）
    const b = parse(z.object({ password: z.string().min(1).max(200) }), await c.req.json().catch(() => null));
    const lock = setupThrottle.lockedUntil(me.id, now);
    if (lock) throw new ApiError(423, `パスワードの入力に続けて失敗したため、しばらくロックしています（あと${Math.ceil((lock - now) / 60000)}分）`);
    setupThrottle.failure(me.id, now);
    if (!(await checkCredentials(db, me.id, b.password)).ok) throw new ApiError(400, "パスワードが違います");
    setupThrottle.success(me.id);
    if (hasTotp(db, me.id)) throw new ApiError(409, "すでに設定されています。変更するには、いったん解除してください");
    const secret = newSecret();
    db.prepare("UPDATE employees SET totp_pending = ? WHERE id = ?").run(sealSecret(secret), me.id);
    const body: TwoFactorSetup = { secret, uri: otpauthUri(BRAND.name, `${c.get("tenant").code}/${me.id}`, secret) };
    return c.json(body);
  });

  app.post("/api/auth/2fa/enable", async (c) => {
    const me = c.get("me");
    const db = c.get("db");
    const now = guard(c);
    const { code } = parse(z.object({ code: z.string().min(6).max(12) }), await c.req.json().catch(() => null));
    const row = db.prepare("SELECT totp_pending AS p FROM employees WHERE id = ?").get(me.id) as { p: string | null };
    if (!row.p) throw new ApiError(409, "先に「設定を始める」を押してください");
    const step = verifyTotp(openSecret(row.p), code, now);
    if (step === undefined) throw new ApiError(400, "確認コードが違います。認証アプリに表示されている6桁を入力してください");
    const recovery = newRecoveryCodes();
    db.prepare("UPDATE employees SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ?, totp_recovery = ? WHERE id = ?").run(
      now,
      step,
      JSON.stringify(recovery.map(hashRecovery)),
      me.id,
    );
    audit(db, now, me.id, "totp_enabled", {});
    // 回復コードは、この応答でしか表示できない
    return c.json({ recoveryCodes: recovery });
  });

  app.post("/api/auth/2fa/disable", async (c) => {
    const me = c.get("me");
    const db = c.get("db");
    const now = guard(c);
    const b = parse(z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(20) }), await c.req.json().catch(() => null));
    if (!hasTotp(db, me.id)) throw new ApiError(409, "二段階認証は設定されていません");
    if (me.role === "admin" && getSetting(db, "require_2fa", "0") === "1") throw new ApiError(409, "会社の設定で、管理者の二段階認証が必須になっているため、解除できません");
    if (!(await checkCredentials(db, me.id, b.password)).ok) throw new ApiError(400, "パスワードが違います");
    if (!checkSecondFactor(db, me.id, b.code, now)) throw new ApiError(400, "確認コードが違います");
    db.prepare("UPDATE employees SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = 0, totp_recovery = NULL WHERE id = ?").run(me.id);
    audit(db, now, me.id, "totp_disabled", {});
    return c.json({ ok: true });
  });

  return app;
}
