import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { realClock } from "./clock";
import { TenantManager } from "./control";
import { seedDemo } from "./seed";

const dataDir = process.env.DATA_DIR ?? "data";
const reset = process.argv.includes("--reset");

if (process.env.NODE_ENV === "production") {
  console.error("本番環境ではデモデータを投入できません");
  process.exit(1);
}
const password = process.env.SEED_PASSWORD ?? "demo-pass-1234";
if (password.length < 8) {
  console.error("SEED_PASSWORD は8文字以上にしてください");
  process.exit(1);
}
if (reset) {
  for (const f of ["control.db", "control.db-wal", "control.db-shm"]) rmSync(join(dataDir, f), { force: true });
  if (existsSync(join(dataDir, "tenants"))) rmSync(join(dataDir, "tenants"), { recursive: true, force: true });
}
const manager = new TenantManager(join(dataDir, "control.db"), join(dataDir, "tenants"));
if (manager.findByCode("demo")) {
  console.error("デモ会社（企業ID: demo）はすでにあります。作り直す場合は --reset を付けてください（このディレクトリのデータはすべて消えます）");
  process.exit(1);
}
const now = realClock("Asia/Tokyo").now();
const tenant = manager.create({ code: "demo", name: "デモ商事株式会社", adminEmail: "admin@example.com", nowMs: now.ts, emailVerified: true });
manager.update(tenant.id, { status: "active" });
seedDemo(manager.db(tenant.id), { today: now.date, nowMin: now.min, password });
manager.close();
console.log(`デモデータを投入しました（${dataDir}）。企業ID: demo / 管理者: e16（山口 恵） / 一般: e01〜e18 / パスワード: SEED_PASSWORD（未指定なら ${password}）`);
