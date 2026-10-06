import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { sessionEmployee } from "./auth";
import type { Clock } from "./clock";
import { ApiError, COOKIE, type AppConfig, type Env } from "./context";
import type { TenantManager } from "./control";
import { accessOf } from "./plans";
import { getEmployee } from "./repo";
import type { BillingGateway } from "./billing";
import type { Mailer } from "./mail";
import { adminRoutes } from "./routes/admin";
import { billingRoutes, webhookRoutes } from "./routes/billing";
import { accountRoutes, publicRoutes, type Deps } from "./routes/auth";
import { scheduleRoutes } from "./routes/schedule";
import { workRoutes } from "./routes/work";

export type { AppConfig } from "./context";
export { ApiError } from "./context";

export interface AppDeps {
  manager: TenantManager;
  /** 会社のタイムゾーンに応じた時計を返す（テストでは固定時計を返す） */
  clockFor: (tz: string) => Clock;
  config: AppConfig;
  mailer: Mailer;
  billing: BillingGateway;
  /** メール内のリンク・決済後の戻り先に使う公開URL。未設定ならメール送信は行わない */
  appUrl?: string;
}

/** 変更を伴うが、契約が無効・期限切れでも許す操作（ログアウト・パスワード変更・課金） */
const ALWAYS_ALLOWED = [/^\/api\/auth\//, /^\/api\/billing\//]; // 解約・停止中でも、課金ページの操作（再申し込み）は許す
/** パスワード変更前でも許す操作 */
const BEFORE_PASSWORD_CHANGE = new Set(["/api/me", "/api/auth/password", "/api/auth/logout"]);

export function createApp(deps: AppDeps): Hono<Env> {
  const { manager, config } = deps;
  const app = new Hono<Env>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // リクエスト本文の大きさに上限を設ける（未ログインでも巨大な本文を送り付けられるため、プロセスごと落とされるのを防ぐ）。
  // CSV取り込みだけ大きめ、Stripe の通知は中くらい。
  const limit = (maxSize: number) =>
    bodyLimit({ maxSize, onError: () => { throw new ApiError(413, "送信するデータが大きすぎます"); } });
  const small = limit(64 * 1024);
  const medium = limit(1024 * 1024);
  const large = limit(3 * 1024 * 1024);
  app.use("/api/*", (c, next) =>
    (["/api/employees/import", "/api/schedules/import"].includes(c.req.path) ? large : c.req.path === "/api/billing/webhook" || c.req.path === "/api/schedules" ? medium : small)(c, next),
  );

  // CSRF対策: 別オリジンからの更新系リクエストを拒否（CORSは無効のまま）
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      const host = (config.trustProxy ? c.req.header("x-forwarded-host") : undefined) ?? c.req.header("host");
      if (origin && new URL(origin).host !== host) throw new ApiError(403, "不正なリクエストです");
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status);
    console.error(err);
    return c.json({ error: "サーバーでエラーが発生しました" }, 500);
  });

  app.notFound((c) => c.json({ error: "見つかりません" }, 404));

  app.get("/api/health", (c) => {
    manager.ping(); // 管理用DBに接続できるか（軽い問い合わせで確認する）
    return c.json({ ok: true });
  });

  const d: Deps = { manager, clockFor: deps.clockFor, config, mailer: deps.mailer, billing: deps.billing, appUrl: deps.appUrl };
  app.route("/", publicRoutes(d));
  app.route("/", webhookRoutes(d));

  // ---- 以降は要ログイン。Cookie（企業ID.トークン）から会社・社員を解決する ----
  app.use("/api/*", async (c, next) => {
    const raw = getCookie(c, COOKIE);
    const dot = raw?.indexOf(".") ?? -1;
    const tenant = raw && dot > 0 ? manager.findById(raw.slice(0, dot)) : undefined;
    if (!raw || !tenant) throw new ApiError(401, "ログインしてください");
    const db = manager.db(tenant.id);
    const clock = deps.clockFor(tenant.tz);
    const now = clock.now();
    const empId = sessionEmployee(db, raw.slice(dot + 1), now.ts);
    const me = empId ? getEmployee(db, empId) : undefined;
    if (!me) throw new ApiError(401, "ログインしてください");
    const access = accessOf(tenant, now.ts);
    if (access.state === "suspended") throw new ApiError(403, "このアカウントは停止されています");

    c.set("tenant", tenant);
    c.set("db", db);
    c.set("clock", clock);
    c.set("me", me);
    c.set("access", access);

    if (me.mustChangePassword && !BEFORE_PASSWORD_CHANGE.has(c.req.path)) {
      throw new ApiError(403, "パスワードを変更してください", "PASSWORD_CHANGE_REQUIRED");
    }
    const mutating = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (mutating && !access.writable && !ALWAYS_ALLOWED.some((re) => re.test(c.req.path))) {
      throw new ApiError(
        402,
        access.state === "trial_expired" ? "無料トライアルが終了しました。引き続きご利用いただくにはお申し込みください" : "ご契約が有効ではないため、変更できません（閲覧とデータの書き出しのみ可能です）",
        access.state.toUpperCase(),
      );
    }
    await next();
  });

  app.route("/", accountRoutes(d));
  app.route("/", workRoutes());
  app.route("/", scheduleRoutes());
  app.route("/", adminRoutes(d));
  app.route("/", billingRoutes(d));
  return app;
}
