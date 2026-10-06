import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { realClock } from "./clock";
import { openDb } from "./db";
import { seedDemo } from "./seed";

const file = process.env.KINTAI_DB ?? "data/kintai.db";
const reset = process.argv.includes("--reset");

if (process.env.NODE_ENV === "production") {
  console.error("本番環境ではデモデータを投入できません");
  process.exit(1);
}
const password = process.env.SEED_PASSWORD ?? "kintai-demo";
if (password.length < 8) {
  console.error("SEED_PASSWORD は8文字以上にしてください");
  process.exit(1);
}
if (reset) for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) rmSync(f);
mkdirSync(dirname(file), { recursive: true });
const db = openDb(file);
const existing = (db.prepare("SELECT COUNT(*) AS n FROM employees").get() as { n: number }).n;
if (existing > 0) {
  console.error("すでにデータがあります。作り直す場合は --reset を付けてください（既存データは消えます）");
  process.exit(1);
}
const now = realClock(process.env.KINTAI_TZ ?? "Asia/Tokyo").now();
seedDemo(db, { today: now.date, nowMin: now.min, password });
console.log(`デモデータを投入しました（${file}）。管理者: e16（山口 恵） / 一般: e01（佐藤 健太） など、パスワードは SEED_PASSWORD（未指定なら kintai-demo）`);
