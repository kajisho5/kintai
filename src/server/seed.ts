/**
 * デモ用のシードデータ。社員・勤務実績は決定論的な擬似乱数で生成しており、
 * 実在の人物・企業とは無関係です。本番データには使わないでください。
 */
import { addDays, dowOf, fiscalStartYm, lastGrantDate, type Employee } from "../domain";
import { HOLIDAYS_JP } from "../domain/holidays-jp";
import { hashPasswordSync } from "./auth";
import { audit, tx, type Db } from "./db";

const HOLIDAY_SET = new Set(HOLIDAYS_JP.map(([d]) => d));

interface SampleEmp extends Employee {
  otMin: number;
  otVar: number;
  satWork: number;
  sunWork: number;
  paidTaken: number;
}

const E = (o: Partial<SampleEmp> & Pick<SampleEmp, "id" | "name" | "dept" | "title">): SampleEmp => ({
  kind: "正社員",
  role: "employee",
  workStyle: "fixed",
  workDays: [1, 2, 3, 4, 5],
  weeklyDays: 5,
  weeklyHours: 40,
  baseMin: 480,
  schedStart: 540,
  otMin: 20,
  otVar: 40,
  satWork: 0.02,
  sunWork: 0,
  hired: "2020-04-01",
  paidTaken: 4,
  carry: 6,
  ...o,
});

const PART = { kind: "パート" as const, baseMin: 360, otMin: 0, otVar: 0, satWork: 0 };

export const SAMPLE_EMPLOYEES: SampleEmp[] = [
  E({ id: "e01", name: "佐藤 健太", dept: "営業部", title: "主任", hired: "2021-04-01", otMin: 40, paidTaken: 3, carry: 8 }),
  E({ id: "e02", name: "鈴木 彩", dept: "営業部", title: "課長", hired: "2016-10-01", otMin: 30, paidTaken: 6, carry: 9 }),
  E({ id: "e03", name: "高橋 翔太", dept: "営業部", title: "", hired: "2023-04-01", otMin: 118, otVar: 60, paidTaken: 2, carry: 4 }),
  E({ id: "e04", name: "田中 美咲", dept: "営業部", title: "", hired: "2024-10-01", otMin: 15, paidTaken: 7, carry: 5 }),
  E({ id: "e05", name: "山本 直樹", dept: "営業部", title: "", hired: "2019-07-01", otMin: 128, otVar: 70, satWork: 0.06, paidTaken: 1, carry: 12 }),
  E({ id: "e06", name: "伊藤 大輔", dept: "開発部", title: "リーダー", hired: "2018-04-01", otMin: 170, otVar: 80, satWork: 0.25, sunWork: 0.1, paidTaken: 1, carry: 14 }),
  E({ id: "e07", name: "小林 優", dept: "開発部", title: "", hired: "2022-10-01", otMin: 148, otVar: 70, satWork: 0.1, paidTaken: 2, carry: 6 }),
  E({ id: "e08", name: "加藤 理沙", dept: "開発部", title: "", hired: "2020-04-01", otMin: 35, paidTaken: 5, carry: 10 }),
  E({ id: "e09", name: "吉田 拓海", dept: "開発部", title: "", hired: "2025-04-01", otMin: 55, paidTaken: 3, carry: 0 }),
  E({ id: "e10", name: "山田 結衣", dept: "開発部", title: "", hired: "2026-04-01", otMin: 10, paidTaken: 0, carry: 0 }),
  E({ id: "e11", name: "松本 蓮", dept: "開発部", title: "", hired: "2017-04-01", otMin: 70, paidTaken: 4, carry: 11 }),
  E({ id: "e12", name: "井上 真由", dept: "カスタマーサポート", title: "リーダー", hired: "2019-04-01", schedStart: 510, otMin: 25, paidTaken: 5, carry: 7 }),
  E({ id: "e13", name: "木村 悠斗", dept: "カスタマーサポート", title: "", hired: "2021-04-01", schedStart: 600, otMin: 20, paidTaken: 4, carry: 6 }),
  E({ id: "e14", name: "林 菜々子", dept: "カスタマーサポート", title: "", ...PART, workDays: [1, 3, 5], weeklyDays: 3, weeklyHours: 18, schedStart: 600, hired: "2022-06-01", paidTaken: 3, carry: 4 }),
  E({ id: "e15", name: "清水 剛", dept: "カスタマーサポート", title: "", ...PART, baseMin: 300, workDays: [2, 4], weeklyDays: 2, weeklyHours: 10, schedStart: 780, hired: "2024-03-01", paidTaken: 1, carry: 2 }),
  E({ id: "e16", name: "山口 恵", dept: "管理部", title: "課長", role: "admin", hired: "2015-04-01", otMin: 45, paidTaken: 8, carry: 12 }),
  E({ id: "e17", name: "森 和也", dept: "管理部", title: "", hired: "2021-10-01", otMin: 20, paidTaken: 4, carry: 8 }),
  E({ id: "e18", name: "池田 香織", dept: "管理部", title: "", ...PART, workDays: [1, 2, 3, 4], weeklyDays: 4, weeklyHours: 24, schedStart: 570, hired: "2023-09-01", paidTaken: 2, carry: 5 }),
];

function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h |= 0;
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shift {
  start: number;
  end: number;
  breaks: { start: number; end: number }[];
}

function shiftOf(e: SampleEmp, date: string, kind: "normal" | "rest"): Shift {
  const r = rng(`${e.id}|${date}`);
  const build = (start: number, worked: number): Shift => {
    const len = worked > 480 ? 60 : worked > 360 ? 45 : 0;
    const bStart = start + 120 < 720 ? 720 : start + 240;
    return { start, end: start + worked + len, breaks: len ? [{ start: bStart, end: bStart + len }] : [] };
  };
  if (kind === "rest") return build(dowOf(date) === 0 ? 570 : 600, 360);
  const start = e.schedStart + Math.round((r() - 0.5) * 20);
  const ot = Math.max(0, Math.round(e.otMin + (r() - 0.5) * e.otVar));
  return build(start, e.baseMin + ot);
}

export interface SeedOptions {
  today: string;
  /** 現在時刻（分）。本日の打刻を「ここまで」生成する */
  nowMin: number;
  password: string;
  adminPassword?: string;
}

export function seedDemo(db: Db, opts: SeedOptions): void {
  const { today, nowMin } = opts;
  const fyStart = `${fiscalStartYm(today)}-01`;
  const hash = hashPasswordSync(opts.password);
  const adminHash = opts.adminPassword ? hashPasswordSync(opts.adminPassword) : hash;
  const now = Date.now();

  tx(db, () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('special_clause', '1')").run();

    const insEmp = db.prepare(
      `INSERT INTO employees (id, name, dept, title, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insEvent = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, source, created_at) VALUES (?, ?, ?, ?, 'punch', ?)");
    const insLeave = db.prepare("INSERT OR IGNORE INTO paid_leave (emp_id, date, days) VALUES (?, ?, ?)");

    const isHoliday = (d: string) => HOLIDAY_SET.has(d);
    const scheduled = (e: SampleEmp, d: string) => e.workDays.includes(dowOf(d)) && !isHoliday(d) && d >= e.hired;

    for (const e of SAMPLE_EMPLOYEES) {
      insEmp.run(e.id, e.name, e.dept, e.title, e.kind, e.role, JSON.stringify(e.workDays), e.weeklyDays, e.weeklyHours, e.baseMin, e.schedStart, e.hired, e.carry, e.role === "admin" ? adminHash : hash);

      // --- 有給の取得日 ---
      const days: string[] = [];
      for (let d = fyStart; d < today; d = addDays(d, 1)) if (d >= e.hired) days.push(d);
      const grant = lastGrantDate(e.hired, today);
      const leave = new Map<string, number>();
      const pool = days.filter((d) => grant && d >= grant && scheduled(e, d));
      const r = rng(`${e.id}|leave`);
      // 付与されたばかりの人が短い期間にほぼ全休にならないよう、期間の営業日数の1/3までに抑える
      const target = Math.min(e.paidTaken, Math.floor(pool.length / 3));
      for (let n = 0; n < target && pool.length; n++) {
        const i = Math.floor(r() * pool.length);
        leave.set(pool.splice(i, 1)[0]!, 1);
      }
      for (const d of days) if (scheduled(e, d) && !leave.has(d) && (!grant || d < grant) && rng(`${e.id}|${d}|l`)() < 0.03) leave.set(d, 1);
      if (e.id === "e04" || e.id === "e17") leave.set(today, 1);
      if (e.id === "e08") leave.set(today, 0.5);
      for (const [d, n] of leave) insLeave.run(e.id, d, n);

      // --- 過去の打刻 ---
      for (const d of days) {
        if (leave.has(d)) continue;
        const w = dowOf(d);
        const rr = rng(`${e.id}|${d}|w`)();
        let shift: Shift | undefined;
        if (w === 0) shift = rr < e.sunWork ? shiftOf(e, d, "rest") : undefined;
        else if (w === 6 || isHoliday(d)) shift = rr < e.satWork ? shiftOf(e, d, "rest") : undefined;
        else if (e.workDays.includes(w)) shift = shiftOf(e, d, "normal");
        if (!shift) continue;
        writeShift(insEvent, e.id, d, shift, Infinity, now);
      }

      // --- 本日（現在時刻まで） ---
      if (!leave.has(today) || leave.get(today) === 0.5) {
        if (scheduled(e, today)) {
          const full = shiftOf(e, today, "normal");
          // 午前半休の人は 13:00 から。所定時間のうち 4 時間ぶんを午前休として差し引く
          const shift: Shift = e.id === "e08" ? { start: 780, end: full.end - full.start - 240 + 780 - (full.breaks[0] ? full.breaks[0].end - full.breaks[0].start : 0), breaks: [] } : full;
          writeShift(insEvent, e.id, today, shift, nowMin, now);
        }
      }
    }

    // --- 申請（デモ） ---
    const insReq = db.prepare("INSERT INTO requests (emp_id, kind, date, payload, reason, status, created_at, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const nextWorkday = (e: SampleEmp, from: string) => { let d = from; while (!scheduled(e, d)) d = addDays(d, 1); return d; };
    const find = (id: string) => SAMPLE_EMPLOYEES.find((x) => x.id === id)!;
    // 実際に出勤した直近の日（有給などで出勤していない日は除く）
    const prevWorkday = (e: SampleEmp, n: number) =>
      (db.prepare("SELECT DISTINCT date FROM punch_events WHERE emp_id = ? AND kind = 'in' AND date < ? ORDER BY date DESC LIMIT 1 OFFSET ?").get(e.id, today, n - 1) as { date: string }).date;
    const at = (daysAgo: number) => now - daysAgo * 86400_000;
    insReq.run("e06", "残業申請", today, JSON.stringify({ start: 1080, end: 1410 }), "リリース前の結合テスト対応", "pending", at(0), null, null);
    insReq.run("e05", "残業申請", today, JSON.stringify({ start: 1080, end: 1260 }), "月末提案書の仕上げ", "pending", at(0), null, null);
    insReq.run("e03", "有給申請", nextWorkday(find("e03"), addDays(today, 7)), JSON.stringify({ days: 1 }), "私用のため", "pending", at(1), null, null);
    insReq.run("e07", "休日出勤", (() => { let d = addDays(today, 4); while (dowOf(d) !== 6) d = addDays(d, 1); return d; })(), JSON.stringify({ start: 600, end: 960 }), "本番環境の移行作業", "pending", at(1), null, null);
    insReq.run("e10", "有給申請", nextWorkday(find("e10"), addDays(today, 14)), JSON.stringify({ days: 1 }), "通院のため", "pending", at(2), null, null);
    insReq.run("e12", "打刻修正", prevWorkday(find("e12"), 1), JSON.stringify({ out: 1155 }), "退勤打刻を忘れたため", "pending", at(1), null, null);
    insReq.run("e02", "打刻修正", prevWorkday(find("e02"), 2), JSON.stringify({ in: 545 }), "打刻端末の不具合", "approved", at(3), "e16", at(2));
    audit(db, now, "seed", "seed", { employees: SAMPLE_EMPLOYEES.length });
  });
}

function writeShift(
  ins: { run: (...a: (string | number)[]) => unknown },
  empId: string,
  date: string,
  s: Shift,
  nowMin: number,
  ts: number,
): void {
  const put = (kind: string, min: number) => {
    if (min <= nowMin) ins.run(empId, date, kind, min, ts);
  };
  put("in", s.start);
  for (const b of s.breaks) {
    put("break_start", b.start);
    put("break_end", b.end);
  }
  put("out", s.end);
}
