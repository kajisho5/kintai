import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { createApp } from "./app";
import { billingFromEnv } from "./billing";
import { realClock, type Clock } from "./clock";
import { TenantManager } from "./control";
import { runJobs } from "./jobs";
import { mailerFromEnv } from "./mail";

// 製品名に依存しない環境変数名にしている（製品名は src/brand.ts で変更する）
const dataDir = process.env.DATA_DIR ?? "data";
const secureCookie = process.env.SECURE_COOKIE === "1";
const trustProxy = process.env.TRUST_PROXY === "1";

if (process.env.NODE_ENV === "production" && !secureCookie) {
  console.warn("警告: 本番環境では HTTPS を前提に SECURE_COOKIE=1 を設定してください");
}

const manager = new TenantManager(join(dataDir, "control.db"), join(dataDir, "tenants"));
const clocks = new Map<string, Clock>();
const clockFor = (tz: string): Clock => {
  let c = clocks.get(tz);
  if (!c) clocks.set(tz, (c = realClock(tz)));
  return c;
};

const mailer = mailerFromEnv(process.env);
const billing = billingFromEnv(process.env);
// メール内のリンクと決済後の戻り先に使う公開URL。Host ヘッダは偽装できるため使わない
if (process.env.NODE_ENV === "production" && !process.env.SECRET_KEY) console.warn("警告: SECRET_KEY が未設定です。二段階認証の秘密鍵が暗号化されずに保存されます");
const appUrl = process.env.APP_URL?.replace(/\/$/, "");
if (!appUrl) console.warn("注意: APP_URL が未設定です。登録・パスワード再設定などのメールは送られません");

const api = createApp({ manager, clockFor, config: { secureCookie, sessionHours: 12, trustProxy }, mailer, billing, appUrl });
const root = new Hono();
root.route("/", api);

// 公開サイト（/）とアプリ（/app/）。ビルド済みなら同じサーバーから配信する
const noCache: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-cache");
};
const immutable: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status === 200) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
};

if (existsSync("dist/index.html")) {
  const page = (route: string, file: string) => root.get(route, noCache, serveStatic({ path: `./dist/site/${file}` }));
  page("/", "index.html");
  for (const p of ["terms", "privacy", "tokushoho"]) {
    page(`/${p}`, `${p}.html`);
    page(`/${p}.html`, `${p}.html`);
  }
  const strip = (p: string) => p.replace(/^\/app/, "");
  root.get("/app", (c) => c.redirect("/app/"));
  // ファイル名にハッシュが付く資産は長期キャッシュ。アプリの HTML は常に最新を確認させる
  root.use("/app/assets/*", immutable, serveStatic({ root: "./dist", rewriteRequestPath: strip }));
  root.get("/app/*", noCache, serveStatic({ path: "./dist/index.html" }));
}

root.get("/robots.txt", (c) =>
  c.text(["User-agent: *", "Allow: /", "Disallow: /app/", "Disallow: /api/", ...(appUrl ? [`Sitemap: ${appUrl}/sitemap.xml`] : [])].join("\n") + "\n"),
);
root.get("/sitemap.xml", (c) => {
  if (!appUrl) return c.notFound();
  const urls = ["/", "/terms", "/privacy", "/tokushoho"].map((p) => `  <url><loc>${appUrl}${p}</loc></url>`).join("\n");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 200, { "Content-Type": "application/xml; charset=utf-8" });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (i) => {
  console.log(`server: http://${i.address}:${i.port}  (data: ${dataDir}, tenants: ${manager.list().length})`);
});

// 定期ジョブ: トライアル終了の案内・座席数の再同期・期限切れデータの削除
const jobDeps = { manager, mailer, billing, clockFor, appUrl };
const runHourly = () =>
  runJobs(jobDeps, { fullSeatReconcile: new Date().getUTCHours() === 18 }) // 日本時間の午前3時ごろに全社を照合
    .then((r) => (r.reminders || r.seatsSynced ? console.log("定期ジョブ:", r) : undefined))
    .catch((e) => console.error("定期ジョブに失敗しました:", e));
setTimeout(runHourly, 30_000).unref();
setInterval(runHourly, 3600_000).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    manager.close();
    process.exit(0);
  });
}
