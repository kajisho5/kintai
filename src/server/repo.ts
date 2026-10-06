import { Ledger, addDays, addYm, type Rounding, fiscalStartYm, flexPeriodOfYm, monthsBetween, periodOfYm, yearlyPeriodOfYm, ymOfDate, type Employee, type LeaveRow, type PunchEvent, type ScheduleRow, type WorkStyle } from "../domain";
import { weekStart } from "../engine";
import type { Clock } from "./clock";
import { rollbackCount, type Db } from "./db";

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
  /** 管理者に二段階認証を必須にする */
  require2fa: boolean;
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
    require2fa: getSetting(db, "require_2fa", "0") === "1",
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
  /** 今の協定期間の月 */
  fyMonths: string[];
  /** 画面・CSV で選べる月（協定期間の月と、その直前の月＝前の協定期間の最終月） */
  pickerMonths: string[];
  /** 今日が属する月（締め日があれば、締め日の翌日以降は翌月分） */
  currentYm: string;
  /** 登録されている打刻場所の数 */
  geoSiteCount: number;
  nowMin: number;
  today: string;
}

export interface SnapshotOptions {
  /** 前の協定期間の最終月を見るとき、その月（36協定のチェックに必要な、前の期間ぶんも読み込む） */
  backTo?: string;
  /** 指定した社員の打刻・シフト・有給だけを読み込む（1人分の画面で、全社員ぶんを読み込まないため） */
  only?: string[];
}

// 同じ状態（同じDB・同じ変更回数・同じ分）に対する集計は、短時間なら使い回す。
// DBへの書き込みがあれば、変更回数が変わるので、使い回さない。
const dbIds = new WeakMap<Db, number>();
let nextDbId = 1;
const snapshotCache = new Map<string, { at: number; snap: Snapshot }>();
const SNAPSHOT_CACHE_MAX = 12;
const SNAPSHOT_CACHE_TTL_MS = 120_000;

/**
 * 現在の協定期間ぶんの打刻を読み込み、集計用の Ledger を作る。
 * 直前の月（前の協定期間の最終月）も選べるよう、その月の初めから読む。backTo にその月を指定すると、
 * その月の36協定のチェックに必要な、前の協定期間ぶんも読み込む（指定しなければ、直前の月の36協定の判定は不完全になる）。
 */
export function snapshot(db: Db, clock: Clock, opts: SnapshotOptions = {}): Snapshot {
  const now = clock.now();
  let id = dbIds.get(db);
  if (!id) dbIds.set(db, (id = nextDbId++));
  const changes = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const key = `${id}|${changes}|${rollbackCount(db)}|${now.date}|${Math.floor(now.min)}|${opts.backTo ?? ""}|${opts.only ? [...opts.only].sort().join(",") : "*"}`;
  const t = Date.now();
  const hit = snapshotCache.get(key);
  if (hit && t - hit.at < SNAPSHOT_CACHE_TTL_MS) return hit.snap;
  const snap = buildSnapshot(db, clock, opts);
  snapshotCache.set(key, { at: t, snap });
  for (const [k, v] of snapshotCache) if (t - v.at >= SNAPSHOT_CACHE_TTL_MS) snapshotCache.delete(k);
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX) snapshotCache.delete(snapshotCache.keys().next().value!);
  return snap;
}

function buildSnapshot(db: Db, clock: Clock, opts: SnapshotOptions): Snapshot {
  const now = clock.now();
  const settings = loadSettings(db);
  const currentYm = ymOfDate(now.date, settings.closingDay);
  const fyStart = fiscalStartYm(`${currentYm}-01`, settings.fyStartMonth);
  const prevYm = addYm(fyStart, -1);
  const back = opts.backTo === prevYm ? prevYm : undefined;
  const loadStartYm = back ? fiscalStartYm(`${back}-01`, settings.fyStartMonth) : prevYm;
  // 読み込みの開始日。1年単位の変形期間・フレックスの清算期間・週（月曜始まり）が、その月より前から始まる場合は、そこから読む。
  // 日またぎで終わる勤務のため、さらに前日から読む
  const earliest = [
    periodOfYm(loadStartYm, settings.closingDay).start,
    yearlyPeriodOfYm(loadStartYm, settings.yearlyStartMonth, settings.closingDay).start,
    flexPeriodOfYm(loadStartYm, settings.flexStartMonth, settings.flexMonths, settings.closingDay).start,
  ].sort()[0]!;
  const from = addDays(weekStart(earliest, 1), -1);
  const only = opts.only;
  const inClause = only ? ` AND emp_id IN (${only.map(() => "?").join(",")})` : "";
  // 社員・日付・記録順に並べて読む（Ledger が、同じ社員・日付の連続した行を、まとめて扱える）
  const events = db
    .prepare(`SELECT emp_id AS empId, date, kind, min, seq FROM punch_events WHERE date >= ?${inClause} ORDER BY emp_id, date, seq`)
    .all(from, ...(only ?? [])) as unknown as PunchEvent[];
  const leaves = (only ? only.flatMap((e) => db.prepare("SELECT emp_id AS empId, date, days FROM paid_leave WHERE emp_id = ?").all(e)) : db.prepare("SELECT emp_id AS empId, date, days FROM paid_leave").all()) as unknown as LeaveRow[];
  const holidays = Object.fromEntries(
    (db.prepare("SELECT date, name FROM holidays").all() as unknown as { date: string; name: string }[]).map((h) => [h.date, h.name]),
  );
  // シフトは、有給の出勤率（直近の1年と少し）の判定にも使うので、集計の範囲より前も読む
  const schedFrom = [from, addDays(now.date, -430)].sort()[0]!;
  const dataFrom = (db.prepare("SELECT MIN(date) AS d FROM punch_events").get() as { d: string | null }).d ?? undefined;
  const worked = db.prepare("SELECT DISTINCT date FROM punch_events WHERE emp_id = ? AND kind = 'in' AND date >= ? AND date < ?");
  const schedules = (
    db
      .prepare(`SELECT emp_id AS empId, date, kind, start, end, break_min AS breakMin FROM schedules WHERE date >= ?${inClause.replace("emp_id", "emp_id")}`)
      .all(schedFrom, ...(only ?? [])) as unknown as (Omit<ScheduleRow, "start" | "end"> & { start: number | null; end: number | null })[]
  ).map((r) => ({ ...r, start: r.start ?? undefined, end: r.end ?? undefined }));
  const ledger = new Ledger({ today: now.date, nowMin: now.min, holidays }, events, leaves, {
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
    dataFrom,
    workedDatesOf: (empId, f, t) => new Set((worked.all(empId, f, t) as unknown as { date: string }[]).map((r) => r.date)),
  });
  const fyMonths = monthsBetween(fyStart, currentYm);
  return { ledger, dateOf: clock.dateOf, settings, employees: loadEmployees(db), allEmployees: loadEmployees(db, true), fyMonths, pickerMonths: [prevYm, ...fyMonths], currentYm, geoSiteCount: (db.prepare("SELECT COUNT(*) AS n FROM geo_sites").get() as { n: number }).n, nowMin: now.min, today: now.date };
}
