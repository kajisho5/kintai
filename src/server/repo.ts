import { Ledger, addDays, fiscalStartYm, monthsBetween, type Employee, type LeaveRow, type PunchEvent } from "../domain";
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
  email: string | null;
  must_change_password: number;
  left_on: string | null;
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
  email: r.email ?? undefined,
  mustChangePassword: r.must_change_password === 1,
  leftOn: r.left_on ?? undefined,
});

/** 在職中の社員。includeLeft なら退職者も含める（過去月の勤怠表示用） */
export function loadEmployees(db: Db, includeLeft = false): Employee[] {
  const rows = db.prepare(`SELECT * FROM employees ${includeLeft ? "" : "WHERE active = 1"} ORDER BY id`).all() as unknown as EmpRow[];
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

export interface CompanySettings {
  specialClause: boolean;
  /** 36協定の協定期間の起算月（1〜12） */
  fyStartMonth: number;
}

export function loadSettings(db: Db): CompanySettings {
  const m = Number(getSetting(db, "fy_start_month", "4"));
  return { specialClause: getSetting(db, "special_clause", "1") === "1", fyStartMonth: m >= 1 && m <= 12 ? m : 4 };
}

export interface Snapshot {
  ledger: Ledger;
  dateOf: (ts: number) => string;
  settings: CompanySettings;
  /** 在職中の社員 */
  employees: Employee[];
  /** 退職者を含む全社員 */
  allEmployees: Employee[];
  fyMonths: string[];
  nowMin: number;
  today: string;
}

/** 現在の協定期間ぶんの打刻を読み込み、集計用の Ledger を作る */
export function snapshot(db: Db, clock: Clock): Snapshot {
  const now = clock.now();
  const settings = loadSettings(db);
  const fyStart = fiscalStartYm(now.date, settings.fyStartMonth);
  // 協定期間の初日に日またぎで終わる勤務のため、前日から読む
  const from = addDays(`${fyStart}-01`, -1);
  const events = (
    db.prepare("SELECT emp_id AS empId, date, kind, min, seq FROM punch_events WHERE date >= ? ORDER BY seq").all(from) as unknown as PunchEvent[]
  ).map((e) => ({ ...e }));
  const leaves = db.prepare("SELECT emp_id AS empId, date, days FROM paid_leave").all() as unknown as LeaveRow[];
  const holidays = Object.fromEntries(
    (db.prepare("SELECT date, name FROM holidays").all() as unknown as { date: string; name: string }[]).map((h) => [h.date, h.name]),
  );
  const ledger = new Ledger({ today: now.date, nowMin: now.min, holidays }, events, leaves.map((l) => ({ ...l })), {
    specialClause: settings.specialClause,
    fiscalStartMonth: settings.fyStartMonth,
  });
  const fyMonths = monthsBetween(fyStart, now.date.slice(0, 7));
  return { ledger, dateOf: clock.dateOf, settings, employees: loadEmployees(db), allEmployees: loadEmployees(db, true), fyMonths, nowMin: now.min, today: now.date };
}
