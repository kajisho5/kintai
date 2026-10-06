import { Ledger, fiscalStartYm, monthsBetween, type Employee, type LeaveRow, type PunchEvent } from "../domain";
import type { Clock } from "./clock";
import type { Db } from "./db";

interface EmpRow {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
  role: "admin" | "employee";
  work_days: string;
  weekly_days: number;
  weekly_hours: number;
  base_min: number;
  sched_start: number;
  hired: string;
  carry: number;
}

const toEmployee = (r: EmpRow): Employee => ({
  id: r.id,
  name: r.name,
  dept: r.dept,
  title: r.title,
  kind: r.kind,
  role: r.role,
  workDays: JSON.parse(r.work_days) as number[],
  weeklyDays: r.weekly_days,
  weeklyHours: r.weekly_hours,
  baseMin: r.base_min,
  schedStart: r.sched_start,
  hired: r.hired,
  carry: r.carry,
});

export function loadEmployees(db: Db): Employee[] {
  const rows = db.prepare("SELECT * FROM employees WHERE active = 1 ORDER BY id").all() as unknown as EmpRow[];
  return rows.map(toEmployee);
}

export function getEmployee(db: Db, id: string): Employee | undefined {
  const r = db.prepare("SELECT * FROM employees WHERE id = ? AND active = 1").get(id) as unknown as EmpRow | undefined;
  return r ? toEmployee(r) : undefined;
}

export function getSetting(db: Db, key: string, fallback: string): string {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? fallback;
}

export interface Snapshot {
  ledger: Ledger;
  employees: Employee[];
  fyMonths: string[];
  nowMin: number;
  today: string;
}

/** 現在の協定期間ぶんの打刻を読み込み、集計用の Ledger を作る */
export function snapshot(db: Db, clock: Clock): Snapshot {
  const now = clock.now();
  const fyStart = fiscalStartYm(now.date);
  const events = (
    db.prepare("SELECT emp_id AS empId, date, kind, min, seq FROM punch_events WHERE date >= ? ORDER BY seq").all(`${fyStart}-01`) as unknown as PunchEvent[]
  ).map((e) => ({ ...e }));
  const leaves = db.prepare("SELECT emp_id AS empId, date, days FROM paid_leave").all() as unknown as LeaveRow[];
  const holidays = Object.fromEntries(
    (db.prepare("SELECT date, name FROM holidays").all() as unknown as { date: string; name: string }[]).map((h) => [h.date, h.name]),
  );
  const ledger = new Ledger({ today: now.date, holidays }, events, leaves.map((l) => ({ ...l })), {
    specialClause: getSetting(db, "special_clause", "1") === "1",
  });
  const fyMonths = monthsBetween(fyStart, now.date.slice(0, 7));
  return { ledger, employees: loadEmployees(db), fyMonths, nowMin: now.min, today: now.date };
}
