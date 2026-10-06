import { performance } from "node:perf_hooks";
import { createApp } from "../src/server/app";
import { fixedClock } from "../src/server/clock";
import { TenantManager } from "../src/server/control";
import { DisabledBilling } from "../src/server/billing";
import { MemoryMailer } from "../src/server/mail";
import { hashPasswordSync } from "../src/server/auth";

const N = Number(process.argv[2] ?? 300);
const manager = new TenantManager(":memory:", ":memory:");
const clock = fixedClock("2026-10-06", "14:00");
const app = createApp({ manager, clockFor: () => clock, config: { secureCookie: false, sessionHours: 12 }, mailer: new MemoryMailer(), billing: new DisabledBilling(), appUrl: "https://x.example.com" });
const t = manager.create({ code: "perf", name: "負荷試験", adminEmail: "a@example.com", nowMs: clock.now().ts, emailVerified: true });
manager.update(t.id, { status: "active" });
const db = manager.db(t.id);
const hash = hashPasswordSync("perf-pass-1234");
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

db.exec("BEGIN");
const insE = db.prepare("INSERT INTO employees (id, name, dept, title, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, password_hash) VALUES (?, ?, ?, '', '正社員', ?, '[1,2,3,4,5]', 5, 40, 480, 540, '2022-04-01', 5, ?)");
const insP = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES (?, ?, ?, ?, 1)");
for (let i = 0; i < N; i++) {
  const id = i === 0 ? "admin" : `e${i}`;
  insE.run(id, `社員${i}`, `部署${i % 12}`, i === 0 ? "admin" : "employee", hash);
  for (let d = "2026-04-01"; d < "2026-10-06"; d = addDays(d, 1)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ot = (i * 7 + d.charCodeAt(9)) % 90;
    insP.run(id, d, "in", 540 + (i % 15), ); insP.run(id, d, "break_start", 720); insP.run(id, d, "break_end", 780); insP.run(id, d, "out", 1080 + ot);
  }
}
db.exec("COMMIT");
const events = (db.prepare("SELECT COUNT(*) AS n FROM punch_events").get() as { n: number }).n;

const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "perf", id: "admin", password: "perf-pass-1234" }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const time = async (label: string, path: string, n = 3) => {
  const ts: number[] = [];
  let size = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await app.request(path, { headers: { cookie } });
    const body = await r.text();
    size = body.length;
    ts.push(performance.now() - t0);
    if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${body.slice(0, 100)}`);
  }
  console.log(`${label.padEnd(26)} ${ts.map((x) => x.toFixed(0).padStart(5)).join(" ")} ms   ${(size / 1024).toFixed(0)} KB`);
};
import { snapshot } from "../src/server/repo";
{
  let t0 = performance.now();
  const snap = snapshot(db, clock, { backTo: "x" });
  console.log("snapshot(読み込み+Ledger構築)", (performance.now() - t0).toFixed(0), "ms");
  t0 = performance.now();
  for (const e of snap.employees) snap.ledger.riskOf(e);
  console.log("riskOf × 全社員", (performance.now() - t0).toFixed(0), "ms");
  t0 = performance.now();
  for (const e of snap.employees) snap.ledger.todayRow(e, snap.nowMin);
  console.log("todayRow × 全社員", (performance.now() - t0).toFixed(0), "ms");
  t0 = performance.now();
  for (const e of snap.employees) snap.ledger.leaveOf(e);
  console.log("leaveOf × 全社員", (performance.now() - t0).toFixed(0), "ms");
}
console.log(`社員 ${N}名 / 打刻 ${events.toLocaleString()}件`);
await time("/api/me", "/api/me");
await time("/api/punch/today", "/api/punch/today");
await time("/api/dashboard", "/api/dashboard");
await time("/api/attendance 前月", "/api/attendance?ym=2026-09");
await time("/api/attendance 当月", "/api/attendance?ym=2026-10");
await time("/api/attendance/e5", "/api/attendance/e5?ym=2026-09");
await time("/api/leave", "/api/leave");
await time("/api/employees", "/api/employees");
await time("export summary", "/api/attendance/export?ym=2026-09&kind=summary");
await time("export detail", "/api/attendance/export?ym=2026-09&kind=detail", 2);
await time("/api/schedules", "/api/schedules?ym=2026-10");

// 運用中の想定: 打刻が入り、時刻が進んだあとに、管理者が画面を開く（差分だけを反映する）
{
  const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES (?, '2026-10-06', ?, ?, 1)");
  let minute = 14 * 60;
  const round = async (label: string, punches: number) => {
    for (let i = 0; i < punches; i++) ins.run(`e${1 + Math.floor(Math.random() * (N - 1))}`, "in", 540);
    minute++;
    clock.set("2026-10-06", `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
    await time(label, "/api/dashboard", 1);
    await time(label.replace("dashboard", "attendance"), "/api/attendance?ym=2026-10", 1);
  };
  console.log("--- 打刻が入ったあとの再表示 ---");
  await round("dashboard(打刻10件)", 10);
  await round("dashboard(打刻50件)", 50);
  await round("dashboard(打刻なし・1分経過)", 0);
  console.log("--- 管理者の操作のあとの再表示 ---");
  db.prepare("INSERT OR REPLACE INTO schedules (emp_id, date, kind, start, end, break_min) VALUES ('e5', '2026-10-10', 'work', 540, 1080, 60)").run();
  await time("dashboard(シフト1件を変更)", "/api/dashboard", 1);
  db.prepare("UPDATE employees SET dept = '別の部署' WHERE id = 'e6'").run();
  await time("dashboard(社員1人を変更)", "/api/dashboard", 1);
  db.prepare("INSERT INTO paid_leave (emp_id, date, days) VALUES ('e7', '2026-10-01', 1)").run();
  await time("dashboard(有給1件を追加)", "/api/dashboard", 1);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('closing_day', '0')").run();
  await time("dashboard(会社設定を変更=作り直し)", "/api/dashboard", 1);
}
console.log("heapUsed MB", (globalThis.gc?.(), (process.memoryUsage().heapUsed/1048576).toFixed(0)), "rss MB", (process.memoryUsage().rss/1048576).toFixed(0));
