import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app";
import { realClock } from "./clock";
import { openDb } from "./db";

const dbFile = process.env.KINTAI_DB ?? "data/kintai.db";
mkdirSync(dirname(dbFile), { recursive: true });
const db = openDb(dbFile);
try {
  chmodSync(dbFile, 0o600); // パスワードのハッシュを含むため、所有者のみ読み書き可にする
} catch {
  /* 権限を変更できない環境（共有ボリューム等）では運用側で制限する */
}
const tz = process.env.KINTAI_TZ ?? "Asia/Tokyo";
const secureCookie = process.env.KINTAI_SECURE_COOKIE === "1";

if (process.env.NODE_ENV === "production" && !secureCookie) {
  console.warn("警告: 本番環境では HTTPS を前提に KINTAI_SECURE_COOKIE=1 を設定してください");
}

const api = createApp(db, realClock(tz), { secureCookie, sessionHours: 12 });
const root = new Hono();
root.route("/", api);

// ビルド済みの画面があれば同じサーバーから配信する（SPA なので未知のパスは index.html）
if (existsSync("dist/index.html")) {
  root.use("/*", serveStatic({ root: "./dist" }));
  root.get("*", serveStatic({ path: "./dist/index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (i) => {
  console.log(`Kintai server: http://${i.address}:${i.port}  (DB: ${dbFile}, TZ: ${tz})`);
});
