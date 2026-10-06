import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app";
import { realClock, type Clock } from "./clock";
import { TenantManager } from "./control";

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

const api = createApp({ manager, clockFor, config: { secureCookie, sessionHours: 12, trustProxy } });
const root = new Hono();
root.route("/", api);

// ビルド済みの画面があれば同じサーバーから配信する（SPA なので未知のパスは index.html）
if (existsSync("dist/index.html")) {
  root.use("/*", serveStatic({ root: "./dist" }));
  root.get("*", serveStatic({ path: "./dist/index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (i) => {
  console.log(`server: http://${i.address}:${i.port}  (data: ${dataDir}, tenants: ${manager.list().length})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    manager.close();
    process.exit(0);
  });
}
