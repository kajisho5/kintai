import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { HOLIDAYS_JP_LAST_YEAR } from "../../domain/holidays-jp";
import type { MeResponse } from "../../domain";
import { burnPasswordCheck, checkCredentials, createSession, destroySession, hashPassword, LoginThrottle } from "../auth";
import { activeCount, ApiError, brief, COOKIE, parse, pendingCount, type AppConfig, type Env } from "../context";
import { validateCode, type TenantManager } from "../control";
import { audit, tx } from "../db";
import { RateLimiter } from "../ratelimit";
import { loadSettings } from "../repo";
import type { Clock } from "../clock";
import type { BillingGateway } from "../billing";
import { templates, type Mailer } from "../mail";
import { PLAN } from "../plans";

export const TERMS_VERSION = "draft-1";

export interface Deps {
  manager: TenantManager;
  clockFor: (tz: string) => Clock;
  config: AppConfig;
  mailer: Mailer;
  billing: BillingGateway;
  /** メール内のリンクに使う公開URL（例: https://app.example.com）。Host ヘッダは信用しない */
  appUrl?: string;
}

const RESET_MINUTES = 60;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function clientIp(c: Context, trustProxy?: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

const setSession = (c: Context, cfg: AppConfig, tenantId: string, token: string) =>
  setCookie(c, COOKIE, `${tenantId}.${token}`, { httpOnly: true, sameSite: "Lax", secure: cfg.secureCookie, path: "/", maxAge: cfg.sessionHours * 3600 });

const signupSchema = z.object({
  companyName: z.string().trim().min(1, "会社名を入力してください").max(60, "会社名は60文字以内で入力してください"),
  code: z.string().trim().toLowerCase(),
  adminName: z.string().trim().min(1, "お名前を入力してください").max(40),
  adminId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,30}$/, "社員IDは半角英数字と . _ - の30文字以内で入力してください").default("admin"),
  email: z.string().trim().toLowerCase().email("メールアドレスの形式が正しくありません").max(120),
  password: z.string().min(10, "パスワードは10文字以上にしてください").max(200),
  acceptTerms: z.boolean().refine((v) => v, "利用規約への同意が必要です"),
});

/** ログイン前に使える API（ログイン・ログアウト・会社登録） */
export function publicRoutes({ manager, clockFor, config, mailer, appUrl }: Deps): Hono<Env> {
  const app = new Hono<Env>();
  const accountThrottle = new LoginThrottle();
  const ipFails = new RateLimiter(20, 10 * 60_000);
  const signupLimit = new RateLimiter(10, 60 * 60_000);
  const checkLimit = new RateLimiter(60, 10 * 60_000);
  const forgotIp = new RateLimiter(10, 10 * 60_000);
  const forgotKey = new RateLimiter(3, 60 * 60_000);
  const resetIp = new RateLimiter(20, 10 * 60_000);

  app.post("/api/auth/login", async (c) => {
    const body = parse(
      z.object({ company: z.string().trim().toLowerCase().min(1).max(40), id: z.string().trim().min(1).max(50), password: z.string().min(1).max(200) }),
      await c.req.json().catch(() => null),
    );
    const now = clockFor("Asia/Tokyo").now().ts; // エポックミリ秒なのでタイムゾーンに依存しない
    const ip = clientIp(c, config.trustProxy);
    const key = `${body.company}/${body.id}`;
    if (ipFails.blocked(ip, now)) throw new ApiError(429, `ログインの試行が多すぎます。${ipFails.retryAfterMin(ip, now)}分ほど待ってからお試しください`);
    const until = accountThrottle.lockedUntil(key, now);
    if (until) throw new ApiError(423, `ログインに続けて失敗したため、しばらくロックしています（あと${Math.ceil((until - now) / 60000)}分）`);

    const fail = (): never => {
      accountThrottle.failure(key, now);
      ipFails.record(ip, now);
      throw new ApiError(401, "企業ID・社員ID・パスワードのいずれかが違います");
    };
    const tenant = manager.findByCode(body.company);
    if (!tenant) {
      burnPasswordCheck(body.password);
      return fail();
    }
    const db = manager.db(tenant.id);
    const r = checkCredentials(db, body.id, body.password);
    if (!r.ok) {
      audit(db, now, body.id, "login_failed", { ip });
      return fail();
    }
    if (tenant.status === "suspended") throw new ApiError(403, "このアカウントは停止されています。サポートにお問い合わせください");
    accountThrottle.success(key);
    const token = createSession(db, r.id, now, config.sessionHours * 3600_000);
    setSession(c, config, tenant.id, token);
    audit(db, now, r.id, "login", { ip });
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    const raw = getCookie(c, COOKIE);
    const dot = raw?.indexOf(".") ?? -1;
    if (raw && dot > 0) {
      const tenant = manager.findById(raw.slice(0, dot));
      if (tenant) destroySession(manager.db(tenant.id), raw.slice(dot + 1));
    }
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/signup/check", (c) => {
    const ip = clientIp(c, config.trustProxy);
    const now = clockFor("Asia/Tokyo").now().ts; // エポックミリ秒なのでタイムゾーンに依存しない
    if (checkLimit.blocked(ip, now)) throw new ApiError(429, "しばらく待ってからお試しください");
    checkLimit.record(ip, now);
    const code = (c.req.query("code") ?? "").trim().toLowerCase();
    const err = validateCode(code);
    if (err) return c.json({ available: false, message: err });
    return c.json(manager.findByCode(code) ? { available: false, message: "この企業IDはすでに使われています" } : { available: true });
  });

  app.post("/api/signup", async (c) => {
    const ip = clientIp(c, config.trustProxy);
    const now = clockFor("Asia/Tokyo").now().ts; // エポックミリ秒なのでタイムゾーンに依存しない
    if (signupLimit.blocked(ip, now)) throw new ApiError(429, "登録の試行が多すぎます。しばらくしてからお試しください");
    signupLimit.record(ip, now);
    const b = parse(signupSchema, await c.req.json().catch(() => null));
    const codeErr = validateCode(b.code);
    if (codeErr) throw new ApiError(400, codeErr);
    if (manager.findByCode(b.code)) throw new ApiError(409, "この企業IDはすでに使われています");

    const tz = "Asia/Tokyo";
    const clock = clockFor(tz);
    const today = clock.now().date;
    const tenant = manager.create({ code: b.code, name: b.companyName, adminEmail: b.email, tz, nowMs: now, termsVersion: TERMS_VERSION });
    try {
      const db = manager.db(tenant.id);
      tx(db, () => {
        db.prepare(
          `INSERT INTO employees (id, name, dept, title, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, password_hash, email)
           VALUES (?, ?, '未設定', '', '正社員', 'admin', '[1,2,3,4,5]', 5, 40, 480, 540, ?, 0, ?, ?)`,
        ).run(b.adminId, b.adminName, today, hashPassword(b.password), b.email);
        audit(db, now, b.adminId, "signup", { company: b.companyName, ip, terms: TERMS_VERSION });
      });
      const token = createSession(db, b.adminId, now, config.sessionHours * 3600_000);
      setSession(c, config, tenant.id, token);
    } catch (e) {
      manager.delete(tenant.id); // 作りかけの会社を残さない
      throw e;
    }
    if (appUrl) {
      const mail = templates.welcome({ adminName: b.adminName, companyName: b.companyName, code: tenant.code, loginUrl: appUrl, trialDays: PLAN.trialDays });
      void mailer.send({ to: b.email, ...mail }).catch((e) => console.error("ご登録メールを送れませんでした:", e instanceof Error ? e.message : e));
    }
    return c.json({ ok: true, code: tenant.code }, 201);
  });

  // ---- パスワードの再設定（メールアドレスを登録している人向け） ----

  app.post("/api/auth/forgot", async (c) => {
    const b = parse(z.object({ company: z.string().trim().toLowerCase().min(1).max(40), email: z.string().trim().toLowerCase().email().max(120) }), await c.req.json().catch(() => null));
    const now = clockFor("Asia/Tokyo").now().ts;
    const ip = clientIp(c, config.trustProxy);
    if (forgotIp.blocked(ip, now) || forgotKey.blocked(`${b.company}/${b.email}`, now)) throw new ApiError(429, "しばらく待ってからもう一度お試しください");
    forgotIp.record(ip, now);
    forgotKey.record(`${b.company}/${b.email}`, now);

    const tenant = manager.findByCode(b.company);
    if (tenant && tenant.status !== "suspended" && appUrl) {
      const db = manager.db(tenant.id);
      const emps = db.prepare("SELECT id FROM employees WHERE active = 1 AND lower(email) = ?").all(b.email) as { id: string }[];
      for (const e of emps) {
        const token = randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO password_resets (token_hash, emp_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), e.id, now + RESET_MINUTES * 60_000);
        const link = `${appUrl}/#/reset?company=${encodeURIComponent(tenant.code)}&token=${token}`;
        void mailer.send({ to: b.email, ...templates.passwordReset({ link, minutes: RESET_MINUTES }) }).catch((err) => console.error("再設定メールを送れませんでした:", err instanceof Error ? err.message : err));
        audit(db, now, e.id, "password_reset_requested", { ip });
      }
    }
    // 登録の有無が分からないよう、結果にかかわらず同じ応答を返す
    return c.json({ ok: true });
  });

  app.post("/api/auth/reset", async (c) => {
    const b = parse(
      z.object({ company: z.string().trim().toLowerCase().min(1).max(40), token: z.string().min(20).max(100), password: z.string().min(8, "新しいパスワードは8文字以上にしてください").max(200) }),
      await c.req.json().catch(() => null),
    );
    const now = clockFor("Asia/Tokyo").now().ts;
    const ip = clientIp(c, config.trustProxy);
    if (resetIp.blocked(ip, now)) throw new ApiError(429, "しばらく待ってからもう一度お試しください");
    resetIp.record(ip, now);
    const invalid = () => new ApiError(400, "このリンクは無効か、有効期限が切れています。もう一度、再設定をお申し込みください");
    const tenant = manager.findByCode(b.company);
    if (!tenant || tenant.status === "suspended") throw invalid();
    const db = manager.db(tenant.id);
    tx(db, () => {
      const row = db.prepare("SELECT emp_id AS id, expires_at AS exp FROM password_resets WHERE token_hash = ? AND used_at IS NULL").get(sha256(b.token)) as { id: string; exp: number } | undefined;
      if (!row || row.exp < now) throw invalid();
      const emp = db.prepare("SELECT id FROM employees WHERE id = ? AND active = 1").get(row.id);
      if (!emp) throw invalid();
      db.prepare("UPDATE employees SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(b.password), row.id);
      db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(row.id);
      db.prepare("UPDATE password_resets SET used_at = ? WHERE emp_id = ?").run(now, row.id); // この人の未使用トークンはすべて無効にする
      audit(db, now, row.id, "password_reset", { ip });
    });
    return c.json({ ok: true });
  });

  return app;
}

/** ログイン後に使える認証まわりの API（自分の情報・パスワード変更） */
export function accountRoutes({ config }: Deps): Hono<Env> {
  const app = new Hono<Env>();
  const throttle = new LoginThrottle();

  app.get("/api/me", (c) => {
    const me = c.get("me");
    const db = c.get("db");
    const tenant = c.get("tenant");
    const access = c.get("access");
    const now = c.get("clock").now();
    const settings = loadSettings(db);
    const year = Number(now.date.slice(0, 4));
    const month = Number(now.date.slice(5, 7));
    const body: MeResponse = {
      employee: { ...brief(me), role: me.role },
      today: now.date,
      nowMin: now.min,
      pending: me.role === "admin" ? pendingCount(db) : 0,
      mustChangePassword: !!me.mustChangePassword,
      tenant: {
        code: tenant.code,
        name: tenant.name,
        state: access.state,
        writable: access.writable,
        trialDaysLeft: access.trialDaysLeft,
        seatsUsed: activeCount(db),
        seatLimit: access.seatLimit,
      },
      settings: { fyStartMonth: settings.fyStartMonth, specialClause: settings.specialClause },
      holidaysStale: year > HOLIDAYS_JP_LAST_YEAR || (year === HOLIDAYS_JP_LAST_YEAR && month >= 10),
    };
    return c.json(body);
  });

  app.post("/api/auth/password", async (c) => {
    const me = c.get("me");
    const db = c.get("db");
    const tenant = c.get("tenant");
    const body = parse(
      z.object({ current: z.string().min(1).max(200), next: z.string().min(8, "新しいパスワードは8文字以上にしてください").max(200) }),
      await c.req.json().catch(() => null),
    );
    const now = c.get("clock").now();
    const key = `${tenant.id}/${me.id}`;
    const until = throttle.lockedUntil(key, now.ts);
    if (until) throw new ApiError(423, "しばらくしてからもう一度お試しください");
    if (!checkCredentials(db, me.id, body.current).ok) {
      throttle.failure(key, now.ts);
      throw new ApiError(400, "現在のパスワードが違います");
    }
    if (body.next === body.current) throw new ApiError(400, "現在と同じパスワードは使えません");
    throttle.success(key);
    db.prepare("UPDATE employees SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(body.next), me.id);
    // 他の端末のログインは無効にし、この端末には新しいセッションを発行する
    db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(me.id);
    const token = createSession(db, me.id, now.ts, config.sessionHours * 3600_000);
    setSession(c, config, tenant.id, token);
    audit(db, now.ts, me.id, "password_change", {});
    return c.json({ ok: true });
  });

  return app;
}
