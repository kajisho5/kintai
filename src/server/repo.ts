import { Ledger, addDays, type Rounding, fiscalStartYm, flexPeriodOfYm, monthsBetween, periodOfYm, yearlyPeriodOfYm, ymOfDate, type Employee, type LeaveRow, type PunchEvent, type ScheduleRow, type WorkStyle } from "../domain";
import type { Clock } from "./clock";
import type { Db } from "./db";

interface EmpRow {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
  role: "admin" | "employee";
  work_style: WorkStyle;
  geo_exempt: number;
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
  workStyle: r.work_style,
  geoExempt: r.geo_exempt === 1,
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
  /** 法定休日の曜日（0=日曜〜6=土曜） */
  legalHolidayDow: number;
  /** 週の法定労働時間が44時間（特例措置対象事業場）か */
  week44: boolean;
  /** フレックスタイム制の清算期間（月数 1〜3）と、その区切りの起点月 */
  flexMonths: number;
  flexStartMonth: number;
  /** 1年単位の変形期間の起点月 */
  yearlyStartMonth: number;
  /** フレックスタイム制のコアタイム（0:00 からの分）。なければ null */
  flexCoreStart: number | null;
  flexCoreEnd: number | null;
  /** 時間外・休日・深夜の月合計の端数処理 */
  rounding: Rounding;
  /** 勤怠の締め日（0 = 月末締め） */
  closingDay: number;
  /** 位置情報による打刻場所の確認 */
  geoMode: "off" | "record" | "enforce";
}

const intIn = (v: string, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

export function loadSettings(db: Db): CompanySettings {
  const coreS = getSetting(db, "flex_core_start", "");
  const coreE = getSetting(db, "flex_core_end", "");
  const core = coreS !== "" && coreE !== "" && Number(coreE) > Number(coreS);
  return {
    specialClause: getSetting(db, "special_clause", "1") === "1",
    fyStartMonth: intIn(getSetting(db, "fy_start_month", "4"), 1, 12, 4),
    legalHolidayDow: intIn(getSetting(db, "legal_holiday_dow", "0"), 0, 6, 0),
    week44: getSetting(db, "week44", "0") === "1",
    flexMonths: intIn(getSetting(db, "flex_months", "1"), 1, 3, 1),
    flexStartMonth: intIn(getSetting(db, "flex_start_month", "4"), 1, 12, 4),
    yearlyStartMonth: intIn(getSetting(db, "yearly_start_month", "4"), 1, 12, 4),
    flexCoreStart: core ? Number(coreS) : null,
    flexCoreEnd: core ? Number(coreE) : null,
    rounding: getSetting(db, "rounding", "none") === "month30" ? "month30" : "none",
    closingDay: intIn(getSetting(db, "closing_day", "0"), 0, 28, 0),
    geoMode: ((v) => (v === "record" || v === "enforce" ? v : "off"))(getSetting(db, "geo_mode", "off")),
  };
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
  /** 今日が属する月（締め日があれば、締め日の翌日以降は翌月分） */
  currentYm: string;
  /** 登録されている打刻場所の数 */
  geoSiteCount: number;
  nowMin: number;
  today: string;
}

/** 現在の協定期間ぶんの打刻を読み込み、集計用の Ledger を作る */
export function snapshot(db: Db, clock: Clock): Snapshot {
  const now = clock.now();
  const settings = loadSettings(db);
  const currentYm = ymOfDate(now.date, settings.closingDay);
  const fyStart = fiscalStartYm(`${currentYm}-01`, settings.fyStartMonth);
  // 協定期間の初日に日またぎで終わる勤務のため、前日から読む。1年単位の変形期間・フレックスの清算期間が協定期間より前から始まる場合は、そこから読む
  const earliest = [
    periodOfYm(fyStart, settings.closingDay).start,
    yearlyPeriodOfYm(currentYm, settings.yearlyStartMonth, settings.closingDay).start,
    flexPeriodOfYm(currentYm, settings.flexStartMonth, settings.flexMonths, settings.closingDay).start,
  ].sort()[0]!;
  const from = addDays(earliest, -1);
  const events = (
    db.prepare("SELECT emp_id AS empId, date, kind, min, seq FROM punch_events WHERE date >= ? ORDER BY seq").all(from) as unknown as PunchEvent[]
  ).map((e) => ({ ...e }));
  const leaves = db.prepare("SELECT emp_id AS empId, date, days FROM paid_leave").all() as unknown as LeaveRow[];
  const holidays = Object.fromEntries(
    (db.prepare("SELECT date, name FROM holidays").all() as unknown as { date: string; name: string }[]).map((h) => [h.date, h.name]),
  );
  const schedules = (
    db.prepare("SELECT emp_id AS empId, date, kind, start, end, break_min AS breakMin FROM schedules WHERE date >= ?").all(from) as unknown as (Omit<ScheduleRow, "start" | "end"> & { start: number | null; end: number | null })[]
  ).map((r) => ({ ...r, start: r.start ?? undefined, end: r.end ?? undefined }));
  const ledger = new Ledger({ today: now.date, nowMin: now.min, holidays }, events, leaves.map((l) => ({ ...l })), {
    specialClause: settings.specialClause,
    fiscalStartMonth: settings.fyStartMonth,
    legalHolidayDow: settings.legalHolidayDow,
    closingDay: settings.closingDay,
    weeklyLegalMin: settings.week44 ? 44 * 60 : 40 * 60,
    flexMonths: settings.flexMonths,
    flexStartMonth: settings.flexStartMonth,
    yearlyStartMonth: settings.yearlyStartMonth,
    flexCore: settings.flexCoreStart !== null ? { start: settings.flexCoreStart, end: settings.flexCoreEnd! } : undefined,
    schedules,
  });
  const fyMonths = monthsBetween(fyStart, currentYm);
  return { ledger, dateOf: clock.dateOf, settings, employees: loadEmployees(db), allEmployees: loadEmployees(db, true), fyMonths, currentYm, geoSiteCount: (db.prepare("SELECT COUNT(*) AS n FROM geo_sites").get() as { n: number }).n, nowMin: now.min, today: now.date };
}
