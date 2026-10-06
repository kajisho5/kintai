import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { HOLIDAYS_JP_LAST_YEAR } from "../../domain/holidays-jp";
import type { MeResponse } from "../../domain";
import { burnPasswordCheck, checkCredentials, createSession, destroySession, hashPassword, LoginThrottle } from "../auth";
import { activeCount, ApiError, brief, COOKIE, parse, pendingCount, requireAdmin, type AppConfig, type Env } from "../context";
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
export const VERIFY_HOURS = 24;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function clientIp(c: Context, trustProxy?: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

const verifyLink = (appUrl: string, code: string, token: string) => `${appUrl}/app/#/verify?company=${encodeURIComponent(code)}&token=${token}`;

const setSession = (c: Context, cfg: AppConfig, tenantId: string, token: string) =>
  setCookie(c, COOKIE, `${tenantId}.${token}`, { httpOnly: true, sameSite: "Lax", secure: cfg.secureCookie, path: "/", maxAge: cfg.sessionHours * 3600 });

/** 1行の名前。改行などの制御文字とURLは受け付けない（案内メールの本文にそのまま入るため、第三者への悪用を防ぐ） */
const plainLine = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label}を入力してください`)
    .max(max, `${label}は${max}文字以内で入力してください`)
    .refine((v) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v), `${label}に使えない文字が含まれています`)
    .refine((v) => !/https?:|www\.|:\/\//i.test(v), `${label}にURLは入力できません`);

const signupSchema = z.object({
  companyName: plainLine("会社名", 60),
  code: z.string().trim().toLowerCase(),
  adminName: plainLine("お名前", 40),
  adminId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,30}$/, "社員IDは半角英数字と . _ - の30文字以内で入力してください").default("admin"),
  email: z.string().trim().toLowerCase().email("メールアドレスの形式が正しくありません").max(120),
  password: z.string().min(10, "パスワードは10文字以上にしてください").max(200),
  acceptTerms: z.boolean().refine((v) => v, "利用規約への同意が必要です"),
});

/** ログイン前に使える API（ログイン・ログアウト・会社登録） */
export function publicRoutes({ manager, clockFor, config, mailer, appUrl }: Deps): Hono<Env> {
  const app = new Hono<Env>();
  // 同じアカウントを同じIPから5回失敗 → 5分ロック。さらに、IPを替えても同じアカウントへの失敗が多すぎれば15分ロック。
  // （アカウント単位だけだと、他人が失敗を重ねて管理者を締め出せてしまう）
  const accountIpThrottle = new LoginThrottle(5, 5 * 60_000);
  const accountThrottle = new LoginThrottle(20, 15 * 60_000);
  const ipFails = new RateLimiter(20, 10 * 60_000);
  const signupLimit = new RateLimiter(10, 60 * 60_000);
  const checkLimit = new RateLimiter(60, 10 * 60_000);
  const forgotIp = new RateLimiter(10, 10 * 60_000);
  // 同じ宛先への案内メールは、IPに関係なく1時間10通まで（メール爆弾の防止）。同じIPからは3通まで
  // （他人が先に申請を使い切って、本人が申請できなくなるのを防ぐため、宛先単位の上限は緩めに）
  const forgotKey = new RateLimiter(10, 60 * 60_000);
  const forgotKeyIp = new RateLimiter(3, 60 * 60_000);
  const resetIp = new RateLimiter(20, 10 * 60_000);
  const verifyIp = new RateLimiter(30, 10 * 60_000);

  app.post("/api/auth/login", async (c) => {
    const body = parse(
      z.object({ company: z.string().trim().toLowerCase().min(1).max(40), id: z.string().trim().min(1).max(50), password: z.string().min(1).max(200) }),
      await c.req.json().catch(() => null),
    );
    const now = clockFor("Asia/Tokyo").now().ts; // エポックミリ秒なのでタイムゾーンに依存しない
    const ip = clientIp(c, config.trustProxy);
    const key = `${body.company}/${body.id}`;
    if (ipFails.blocked(ip, now)) throw new ApiError(429, `ログインの試行が多すぎます。${ipFails.retryAfterMin(ip, now)}分ほど待ってからお試しください`);
    const until = Math.max(accountIpThrottle.lockedUntil(`${key}|${ip}`, now), accountThrottle.lockedUntil(key, now));
    if (until) throw new ApiError(423, `ログインに続けて失敗したため、しばらくロックしています（あと${Math.ceil((until - now) / 60000)}分）`);

    const fail = (): never => {
      accountIpThrottle.failure(`${key}|${ip}`, now);
      accountThrottle.failure(key, now);
      ipFails.record(ip, now);
      throw new ApiError(401, "企業ID・社員ID・パスワードのいずれかが違います");
    };
    const tenant = manager.findByCode(body.company);
    if (!tenant) {
      await burnPasswordCheck(body.password);
      return fail();
    }
    const db = manager.db(tenant.id);
    const r = await checkCredentials(db, body.id, body.password);
    if (!r.ok) {
      audit(db, now, body.id, "login_failed", { ip });
      return fail();
    }
    if (tenant.status === "suspended") throw new ApiError(403, "このアカウントは停止されています。サポートにお問い合わせください");
    accountIpThrottle.success(`${key}|${ip}`);
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

    const pwHash = await hashPassword(b.password); // 重い計算は、会社を作る前・トランザクションの外で行う
    const tz = "Asia/Tokyo";
    const clock = clockFor(tz);
    const today = clock.now().date;
    let tenant;
    try {
      // メールを送れない環境（APP_URL 未設定）では確認の手段がないため、確認済みとして扱う
      tenant = manager.create({ code: b.code, name: b.companyName, adminEmail: b.email, tz, nowMs: now, termsVersion: TERMS_VERSION, emailVerified: !appUrl });
    } catch (e) {
      // 事前の確認のあとで同じ企業IDが登録された（同時登録）場合
      if (e instanceof Error && /UNIQUE/i.test(e.message)) throw new ApiError(409, "この企業IDはすでに使われています");
      throw e;
    }
    try {
      const db = manager.db(tenant.id);
      tx(db, () => {
        db.prepare(
          `INSERT INTO employees (id, name, dept, title, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, password_hash, email)
           VALUES (?, ?, '未設定', '', '正社員', 'admin', '[1,2,3,4,5]', 5, 40, 480, 540, ?, 0, ?, ?)`,
        ).run(b.adminId, b.adminName, today, pwHash, b.email);
        audit(db, now, b.adminId, "signup", { company: b.companyName, ip, terms: TERMS_VERSION });
      });
      const token = createSession(db, b.adminId, now, config.sessionHours * 3600_000);
      setSession(c, config, tenant.id, token);
    } catch (e) {
      manager.delete(tenant.id); // 作りかけの会社を残さない
      throw e;
    }
    if (appUrl) {
      const token = manager.issueEmailVerification(tenant.id, b.email, now, VERIFY_HOURS * 3600_000);
      const mail = templates.welcome({
        adminName: b.adminName,
        companyName: b.companyName,
        code: tenant.code,
        loginUrl: `${appUrl}/app/`,
        verifyUrl: verifyLink(appUrl, tenant.code, token),
        trialDays: PLAN.trialDays,
        hours: VERIFY_HOURS,
      });
      void mailer.send({ to: b.email, ...mail }).catch((e) => console.error("ご登録メールを送れませんでした:", e instanceof Error ? e.message : e));
    }
    return c.json({ ok: true, code: tenant.code }, 201);
  });

  // ---- メールアドレスの確認（メールのリンクから開く。ログインしていなくてもよい） ----

  app.post("/api/signup/verify", async (c) => {
    const b = parse(z.object({ company: z.string().trim().toLowerCase().min(1).max(40), token: z.string().min(20).max(100) }), await c.req.json().catch(() => null));
    const now = clockFor("Asia/Tokyo").now().ts;
    const ip = clientIp(c, config.trustProxy);
    if (verifyIp.blocked(ip, now)) throw new ApiError(429, "しばらく待ってからもう一度お試しください");
    verifyIp.record(ip, now);
    const tenant = manager.findByCode(b.company);
    const done = tenant ? manager.confirmEmail(tenant.id, b.token, now) : undefined;
    if (!tenant || !done) throw new ApiError(400, "このリンクは無効か、有効期限が切れています。ログインして、確認メールをもう一度送ってください");
    audit(manager.db(tenant.id), now, "-", "email_verified", { ip });
    return c.json({ ok: true, code: tenant.code });
  });

  // ---- パスワードの再設定（メールアドレスを登録している人向け） ----

  app.post("/api/auth/forgot", async (c) => {
    const b = parse(z.object({ company: z.string().trim().toLowerCase().min(1).max(40), email: z.string().trim().toLowerCase().email().max(120) }), await c.req.json().catch(() => null));
    const now = clockFor("Asia/Tokyo").now().ts;
    const ip = clientIp(c, config.trustProxy);
    const k = `${b.company}/${b.email}`;
    if (forgotIp.blocked(ip, now) || forgotKey.blocked(k, now) || forgotKeyIp.blocked(`${k}|${ip}`, now)) throw new ApiError(429, "しばらく待ってからもう一度お試しください");
    forgotIp.record(ip, now);
    forgotKey.record(k, now);
    forgotKeyIp.record(`${k}|${ip}`, now);

    const tenant = manager.findByCode(b.company);
    // メールアドレスが未確認の会社には送らない（他人のアドレスで登録された場合に、そのアドレスへ繰り返し送られるのを防ぐ）
    if (tenant && tenant.status !== "suspended" && tenant.adminEmailVerifiedAt && appUrl) {
      const db = manager.db(tenant.id);
      const emps = db.prepare("SELECT id FROM employees WHERE active = 1 AND lower(email) = ?").all(b.email) as { id: string }[];
      for (const e of emps) {
        const token = randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO password_resets (token_hash, emp_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), e.id, now + RESET_MINUTES * 60_000);
        const link = `${appUrl}/app/#/reset?company=${encodeURIComponent(tenant.code)}&token=${token}`;
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
    const pwHash = await hashPassword(b.password);
    tx(db, () => {
      const row = db.prepare("SELECT emp_id AS id, expires_at AS exp FROM password_resets WHERE token_hash = ? AND used_at IS NULL").get(sha256(b.token)) as { id: string; exp: number } | undefined;
      if (!row || row.exp < now) throw invalid();
      const emp = db.prepare("SELECT id FROM employees WHERE id = ? AND active = 1").get(row.id);
      if (!emp) throw invalid();
      db.prepare("UPDATE employees SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(pwHash, row.id);
      db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(row.id);
      db.prepare("UPDATE password_resets SET used_at = ? WHERE emp_id = ?").run(now, row.id); // この人の未使用トークンはすべて無効にする
      audit(db, now, row.id, "password_reset", { ip });
    });
    return c.json({ ok: true });
  });

  return app;
}

/** ログイン後に使える認証まわりの API（自分の情報・パスワード変更） */
export function accountRoutes({ config, manager, mailer, appUrl }: Deps): Hono<Env> {
  const app = new Hono<Env>();
  const throttle = new LoginThrottle();
  const resendLimit = new RateLimiter(5, 60 * 60_000);
  // 成功も含めて回数を数える（重いパスワード計算を繰り返し呼ばせないため）
  const changeLimit = new RateLimiter(10, 60 * 60_000);

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
        emailVerified: !!tenant.adminEmailVerifiedAt,
        ...(me.role === "admin" && !tenant.adminEmailVerifiedAt ? { adminEmail: tenant.adminEmail } : {}),
      },
      settings: { fyStartMonth: settings.fyStartMonth, specialClause: settings.specialClause },
      holidaysStale: year > HOLIDAYS_JP_LAST_YEAR || (year === HOLIDAYS_JP_LAST_YEAR && month >= 10),
    };
    return c.json(body);
  });

  /** 確認メールを再送する。入力ミスのときは、メールアドレスを直して送り直せる（確認が済むまで） */
  app.post("/api/auth/verify/resend", async (c) => {
    const me = requireAdmin(c);
    const tenant = manager.findById(c.get("tenant").id)!;
    const db = c.get("db");
    const now = c.get("clock").now().ts;
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email("メールアドレスの形式が正しくありません").max(120).optional() }), await c.req.json().catch(() => ({})));
    if (tenant.adminEmailVerifiedAt) throw new ApiError(409, "メールアドレスはすでに確認済みです");
    if (!appUrl) throw new ApiError(503, "メールを送信できない設定です。運営にお問い合わせください");
    if (resendLimit.blocked(tenant.id, now)) throw new ApiError(429, "確認メールの送信が多すぎます。しばらくしてからお試しください");
    resendLimit.record(tenant.id, now);
    if (body.email && body.email !== tenant.adminEmail) {
      manager.changeAdminEmail(tenant.id, body.email);
      db.prepare("UPDATE employees SET email = ? WHERE id = ?").run(body.email, me.id);
      audit(db, now, me.id, "admin_email_changed", { from: tenant.adminEmail, to: body.email });
    }
    const email = body.email ?? tenant.adminEmail;
    const token = manager.issueEmailVerification(tenant.id, email, now, VERIFY_HOURS * 3600_000);
    try {
      await mailer.send({ to: email, ...templates.verifyEmail({ adminName: me.name, verifyUrl: verifyLink(appUrl, tenant.code, token), hours: VERIFY_HOURS }) });
    } catch (e) {
      console.error("確認メールを送れませんでした:", e instanceof Error ? e.message : e);
      throw new ApiError(502, "メールを送信できませんでした。しばらくしてからもう一度お試しください");
    }
    audit(db, now, me.id, "email_verification_sent", {});
    return c.json({ ok: true, email });
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
    if (changeLimit.blocked(key, now.ts)) throw new ApiError(429, "パスワードの変更が多すぎます。しばらくしてからお試しください");
    changeLimit.record(key, now.ts);
    if (!(await checkCredentials(db, me.id, body.current)).ok) {
      throttle.failure(key, now.ts);
      throw new ApiError(400, "現在のパスワードが違います");
    }
    if (body.next === body.current) throw new ApiError(400, "現在と同じパスワードは使えません");
    throttle.success(key);
    const nextHash = await hashPassword(body.next);
    db.prepare("UPDATE employees SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(nextHash, me.id);
    // 他の端末のログインは無効にし、この端末には新しいセッションを発行する
    db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(me.id);
    const token = createSession(db, me.id, now.ts, config.sessionHours * 3600_000);
    setSession(c, config, tenant.id, token);
    audit(db, now.ts, me.id, "password_change", {});
    return c.json({ ok: true });
  });

  return app;
}
