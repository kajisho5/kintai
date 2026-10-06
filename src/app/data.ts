/**
 * デモ用のサンプルデータ。
 * 社員・勤務実績は決定論的な擬似乱数で生成しており、実在の人物・企業とは無関係です。
 * 集計はすべて src/engine（calcMonth / check36 / grantDays）を通して算出します。
 */
import {
  calcDay,
  calcMonth,
  check36,
  grantDays,
  remainingObligation,
  type Alert,
  type DayInput,
  type DayResult,
  type Interval,
  type MonthResult,
  type MonthlyTotals,
} from "../engine";
import { dowOf, ymd } from "./format";
import type { PunchState } from "./store";

export const TODAY = ymd(new Date());
export const CURRENT_YM = TODAY.slice(0, 7);
export const SPECIAL_CLAUSE = true; // 特別条項付き36協定を締結している想定
export const COMPANY = "ミナト商事株式会社";

// ---------------------------------------------------------------- 社員

export interface Employee {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
  workDays: number[];
  weeklyDays: number;
  weeklyHours: number;
  baseMin: number;
  startMin: number;
  otMin: number;
  otVar: number;
  satWork: number;
  sunWork: number;
  hired: string;
  paidTaken: number;
  carry: number;
  isMe?: boolean;
}

const E = (o: Partial<Employee> & Pick<Employee, "id" | "name" | "dept" | "title">): Employee => ({
  kind: "正社員",
  workDays: [1, 2, 3, 4, 5],
  weeklyDays: 5,
  weeklyHours: 40,
  baseMin: 480,
  startMin: 540,
  otMin: 20,
  otVar: 40,
  satWork: 0.02,
  sunWork: 0,
  hired: "2020-04-01",
  paidTaken: 4,
  carry: 6,
  ...o,
});

export const EMPLOYEES: Employee[] = [
  E({ id: "e01", name: "佐藤 健太", dept: "営業部", title: "主任", hired: "2021-04-01", otMin: 40, paidTaken: 3, carry: 8, isMe: true }),
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
  E({ id: "e12", name: "井上 真由", dept: "カスタマーサポート", title: "リーダー", hired: "2019-04-01", startMin: 510, otMin: 25, paidTaken: 5, carry: 7 }),
  E({ id: "e13", name: "木村 悠斗", dept: "カスタマーサポート", title: "", hired: "2021-04-01", startMin: 600, otMin: 20, paidTaken: 4, carry: 6 }),
  E({
    id: "e14", name: "林 菜々子", dept: "カスタマーサポート", title: "", kind: "パート", workDays: [1, 3, 5], weeklyDays: 3, weeklyHours: 18,
    baseMin: 360, startMin: 600, otMin: 0, otVar: 0, satWork: 0, hired: "2022-06-01", paidTaken: 3, carry: 4,
  }),
  E({
    id: "e15", name: "清水 剛", dept: "カスタマーサポート", title: "", kind: "パート", workDays: [2, 4], weeklyDays: 2, weeklyHours: 10,
    baseMin: 300, startMin: 780, otMin: 0, otVar: 0, satWork: 0, hired: "2024-03-01", paidTaken: 1, carry: 2,
  }),
  E({ id: "e16", name: "山口 恵", dept: "管理部", title: "課長", hired: "2015-04-01", otMin: 45, paidTaken: 8, carry: 12 }),
  E({ id: "e17", name: "森 和也", dept: "管理部", title: "", hired: "2021-10-01", otMin: 20, paidTaken: 4, carry: 8 }),
  E({
    id: "e18", name: "池田 香織", dept: "管理部", title: "", kind: "パート", workDays: [1, 2, 3, 4], weeklyDays: 4, weeklyHours: 24,
    baseMin: 360, startMin: 570, otMin: 0, otVar: 0, satWork: 0, hired: "2023-09-01", paidTaken: 2, carry: 5,
  }),
];

export const ME = EMPLOYEES.find((e) => e.isMe)!;
export const DEPTS = [...new Set(EMPLOYEES.map((e) => e.dept))];

// ---------------------------------------------------------------- カレンダー

const HOLIDAYS: Record<string, string> = {
  "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日",
  "2026-05-04": "みどりの日",
  "2026-05-05": "こどもの日",
  "2026-05-06": "振替休日",
  "2026-07-20": "海の日",
  "2026-08-11": "山の日",
  "2026-09-21": "敬老の日",
  "2026-09-22": "国民の休日",
  "2026-09-23": "秋分の日",
  "2026-10-12": "スポーツの日",
  "2026-11-03": "文化の日",
  "2026-11-23": "勤労感謝の日",
};

export const holidayName = (date: string): string | undefined => HOLIDAYS[date];

export function datesOfMonth(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
}

const isBusinessDay = (date: string): boolean => {
  const w = dowOf(date);
  return w >= 1 && w <= 5 && !HOLIDAYS[date];
};

/** 協定期間（4/1 起算）の開始月 */
export function fiscalStartYm(today = TODAY): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-04`;
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export const FY_MONTHS = monthsBetween(fiscalStartYm(), CURRENT_YM);

// ---------------------------------------------------------------- 日次の勤務予定（サンプル生成）

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

export type DayKind = "work" | "leave" | "off";

export interface DayPlan {
  date: string;
  kind: DayKind;
  start?: number;
  end?: number;
  breaks: Interval[];
  isLegalHoliday?: boolean;
  note?: string;
}

// 本日の状況を見せるための固定設定（サンプル）
const TODAY_FORCED: Record<string, "leave" | "halfAM"> = { e04: "leave", e17: "leave", e08: "halfAM" };

export function planDay(e: Employee, date: string): DayPlan {
  const r = rng(`${e.id}|${date}`);
  const w = dowOf(date);
  const hol = HOLIDAYS[date];
  const off = (note?: string): DayPlan => ({ date, kind: "off", breaks: [], note });

  const buildWork = (start: number, worked: number, extra: Partial<DayPlan> = {}): DayPlan => {
    const len = worked > 480 ? 60 : worked > 360 ? 45 : 0;
    const bStart = start + 120 < 720 ? 720 : start + 240;
    const breaks = len ? [{ start: bStart, end: bStart + len }] : [];
    return { date, kind: "work", start, end: start + worked + len, breaks, ...extra };
  };

  if (w === 0) {
    if (r() < e.sunWork) return buildWork(570, 360, { isLegalHoliday: true, note: "休日出勤" });
    return off("法定休日");
  }
  if (w === 6 || hol) {
    if (r() < e.satWork) return buildWork(600, 360, { note: hol ? "祝日出勤" : "休日出勤" });
    return off(hol ?? "所定休日");
  }
  if (!e.workDays.includes(w)) return off("所定休日");

  if (date === TODAY && TODAY_FORCED[e.id] === "leave") return { date, kind: "leave", breaks: [], note: "有給休暇" };
  if (date !== TODAY && r() < 0.04) return { date, kind: "leave", breaks: [], note: "有給休暇" };

  const start = e.startMin + Math.round((r() - 0.5) * 20);
  const ot = Math.max(0, Math.round(e.otMin + (r() - 0.5) * e.otVar));
  if (date === TODAY && TODAY_FORCED[e.id] === "halfAM") return buildWork(780, e.baseMin - 240 + ot, { note: "午前休" });
  return buildWork(start, e.baseMin + ot);
}

const toInput = (p: DayPlan): DayInput => ({
  date: p.date,
  work: { start: p.start!, end: p.end! },
  breaks: p.breaks,
  isLegalHoliday: p.isLegalHoliday,
});

// ---------------------------------------------------------------- 月次集計

export interface MonthData {
  ym: string;
  plans: DayPlan[];
  result: MonthResult;
  workDays: number;
  leaveDays: number;
}

const monthCache = new Map<string, MonthData>();

/** 当月は前日までを集計対象にする（本日分は打刻中のため含めない） */
export function monthOf(e: Employee, ym: string): MonthData {
  const key = `${e.id}|${ym}`;
  const hit = monthCache.get(key);
  if (hit) return hit;
  const plans = ym > CURRENT_YM ? [] : datesOfMonth(ym).filter((d) => d < TODAY).map((d) => planDay(e, d));
  const worked = plans.filter((p) => p.kind === "work");
  const result = calcMonth(worked.map(toInput));
  const data = { ym, plans, result, workDays: worked.length, leaveDays: plans.filter((p) => p.kind === "leave").length };
  monthCache.set(key, data);
  return data;
}

export function businessDays(ym: string, until?: string): { elapsed: number; total: number } {
  const all = datesOfMonth(ym).filter(isBusinessDay);
  return { elapsed: all.filter((d) => (until ? d < until : true)).length, total: all.length };
}

export interface Outlook {
  /** 前日までの累計（時間外） */
  mtdOvertime: number;
  /** 月末見込（時間外） */
  projOvertime: number;
  holiday: number;
}

export function outlookOf(e: Employee, ym: string): Outlook {
  const m = monthOf(e, ym).result;
  if (ym !== CURRENT_YM) return { mtdOvertime: m.overtimeMin, projOvertime: m.overtimeMin, holiday: m.legalHolidayMin };
  const { elapsed, total } = businessDays(ym, TODAY);
  const prior = FY_MONTHS.filter((x) => x < ym)
    .slice(-3)
    .map((x) => monthOf(e, x).result.overtimeMin);
  const prevAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : m.overtimeMin;
  const extrap = elapsed > 0 ? (m.overtimeMin / elapsed) * total : prevAvg;
  const w = Math.min(1, elapsed / 10);
  return { mtdOvertime: m.overtimeMin, projOvertime: Math.round(w * extrap + (1 - w) * prevAvg), holiday: m.legalHolidayMin };
}

// ---------------------------------------------------------------- 36協定リスク

export type RiskLevel = "ok" | "warning" | "violation";

export interface Risk {
  level: RiskLevel;
  alerts: Alert[];
  yearOvertime: number;
  over45Count: number;
  outlook: Outlook;
}

const riskCache = new Map<string, Risk>();

export function riskOf(e: Employee, ym: string = CURRENT_YM): Risk {
  const key = `${e.id}|${ym}`;
  const hit = riskCache.get(key);
  if (hit) return hit;
  const outlook = outlookOf(e, ym);
  const history: MonthlyTotals[] = monthsBetween(fiscalStartYm(`${ym}-01`), ym).map((x) => {
    if (x === ym) return { month: x, overtimeMin: outlook.projOvertime, legalHolidayMin: outlook.holiday };
    const r = monthOf(e, x).result;
    return { month: x, overtimeMin: r.overtimeMin, legalHolidayMin: r.legalHolidayMin };
  });
  const alerts = check36(history, { hasSpecialClause: SPECIAL_CLAUSE });
  const level: RiskLevel = alerts.some((a) => a.level === "violation") ? "violation" : alerts.length ? "warning" : "ok";
  const risk = {
    level,
    alerts,
    yearOvertime: history.reduce((s, m) => s + m.overtimeMin, 0),
    over45Count: history.filter((m) => m.overtimeMin > 45 * 60).length,
    outlook,
  };
  riskCache.set(key, risk);
  return risk;
}

// ---------------------------------------------------------------- 本日のダイヤ

export interface Bar {
  from: number;
  to: number;
  ot: boolean;
  plan: boolean;
}

function subtract(range: Interval, breaks: Interval[]): Interval[] {
  let segs = [{ ...range }];
  for (const b of breaks) {
    segs = segs.flatMap((s) => {
      if (b.end <= s.start || b.start >= s.end) return [s];
      const out: Interval[] = [];
      if (b.start > s.start) out.push({ start: s.start, end: b.start });
      if (b.end < s.end) out.push({ start: b.end, end: s.end });
      return out;
    });
  }
  return segs;
}

/** 実労働の帯。8時間を超えた部分は時間外、現在時刻より先は予定として区別する */
export function barsFor(start: number, end: number, breaks: Interval[], now: number): Bar[] {
  const bars: Bar[] = [];
  let cum = 0;
  for (const p of subtract({ start, end }, breaks)) {
    let a = p.start;
    while (a < p.end) {
      let b = cum < 480 ? Math.min(p.end, a + (480 - cum)) : p.end;
      if (a < now && b > now) b = now;
      bars.push({ from: a, to: b, ot: cum >= 480, plan: a >= now });
      cum += b - a;
      a = b;
    }
  }
  return bars;
}

export type Status = "working" | "break" | "left" | "before" | "missing" | "leave" | "off";

export const STATUS_LABEL: Record<Status, string> = {
  working: "勤務中",
  break: "休憩中",
  left: "退勤済",
  before: "出勤前",
  missing: "打刻なし",
  leave: "休暇",
  off: "休み",
};

export interface TodayRow {
  emp: Employee;
  status: Status;
  note?: string;
  start?: number;
  end?: number;
  bars: Bar[];
  workedMin: number;
}

const SCHED_START = 540;

export function todayRows(now: number, punch: PunchState): TodayRow[] {
  return EMPLOYEES.map((emp): TodayRow => {
    if (emp.isMe) return meRow(emp, now, punch);
    const p = planDay(emp, TODAY);
    if (p.kind === "leave") return { emp, status: "leave", note: p.note, bars: [], workedMin: 0 };
    if (p.kind === "off") return { emp, status: "off", note: p.note, bars: [], workedMin: 0 };
    const start = p.start!;
    const end = p.end!;
    const bars = barsFor(start, end, p.breaks, now);
    const worked = bars.filter((b) => !b.plan).reduce((s, b) => s + (b.to - b.from), 0);
    let status: Status;
    if (now < start) status = p.note === "午前休" ? "leave" : now > SCHED_START + 15 && start <= SCHED_START + 60 ? "missing" : "before";
    else if (now >= end) status = "left";
    else if (p.breaks.some((b) => now >= b.start && now < b.end)) status = "break";
    else status = "working";
    return { emp, status, note: p.note, start, end, bars, workedMin: worked };
  });
}

function meRow(emp: Employee, now: number, punch: PunchState): TodayRow {
  const ev = punch.events;
  if (ev.in === undefined) {
    const w = dowOf(TODAY);
    const off = w === 0 || w === 6 || !!HOLIDAYS[TODAY];
    return { emp, status: off ? "off" : now > SCHED_START + 15 ? "missing" : "before", bars: [], workedMin: 0 };
  }
  const breaks = ev.breaks.map((b) => ({ start: b.start, end: b.end ?? now }));
  const end = ev.out ?? now;
  const bars = barsFor(ev.in, end, breaks, now + 1);
  const worked = bars.reduce((s, b) => s + (b.to - b.from), 0);
  const onBreak = ev.out === undefined && ev.breaks.some((b) => b.end === undefined);
  return { emp, status: ev.out !== undefined ? "left" : onBreak ? "break" : "working", start: ev.in, end: ev.out, bars, workedMin: worked };
}

/** 自分の本日分を打刻データから集計（engine 経由） */
export function meToday(punch: PunchState, now: number): DayResult {
  const ev = punch.events;
  if (ev.in === undefined) return calcDay({ date: TODAY });
  return calcDay({
    date: TODAY,
    work: { start: ev.in, end: Math.max(ev.in, ev.out ?? now) },
    breaks: ev.breaks.map((b) => ({ start: b.start, end: b.end ?? now })),
    isLegalHoliday: dowOf(TODAY) === 0,
  });
}

// ---------------------------------------------------------------- 有給

export interface LeaveInfo {
  emp: Employee;
  granted: number;
  taken: number;
  carry: number;
  remaining: number;
  lastGrant?: string;
  nextGrant: string;
  periodEnd?: string;
  obligationLeft: number;
  daysToDeadline?: number;
}

const addMonths = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

const diffDays = (a: string, b: string): number =>
  Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);

export function leaveOf(e: Employee): LeaveInfo {
  let grantAt = addMonths(e.hired, 6);
  if (grantAt > TODAY) {
    return { emp: e, granted: 0, taken: 0, carry: 0, remaining: 0, nextGrant: grantAt, obligationLeft: 0 };
  }
  let months = 6;
  while (addMonths(e.hired, months + 12) <= TODAY) months += 12;
  grantAt = addMonths(e.hired, months);
  const granted = grantDays({ monthsOfService: months, weeklyDays: e.weeklyDays, weeklyHours: e.weeklyHours, attendanceRate: 0.95 });
  const periodEnd = addMonths(grantAt, 12);
  const taken = Math.min(e.paidTaken, granted + e.carry);
  return {
    emp: e,
    granted,
    taken,
    carry: e.carry,
    remaining: Math.max(0, e.carry + granted - taken),
    lastGrant: grantAt,
    nextGrant: periodEnd,
    periodEnd,
    obligationLeft: remainingObligation(granted, taken),
    daysToDeadline: diffDays(TODAY, periodEnd),
  };
}

// ---------------------------------------------------------------- 申請

export type RequestKind = "残業申請" | "打刻修正" | "有給申請" | "休日出勤";

export interface RequestItem {
  id: string;
  empId: string;
  kind: RequestKind;
  /** 対象日 */
  date: string;
  detail: string;
  reason: string;
  submitted: string;
  initial: "pending" | "approved" | "rejected";
}

const dayBefore = (n: number): string => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export const REQUESTS: RequestItem[] = [
  { id: "r1", empId: "e06", kind: "残業申請", date: TODAY, detail: "18:00 → 23:30（5時間30分）", reason: "リリース前の結合テスト対応", submitted: dayBefore(0), initial: "pending" },
  { id: "r2", empId: "e03", kind: "有給申請", date: dayBefore(-7), detail: "全日 1日", reason: "私用のため", submitted: dayBefore(1), initial: "pending" },
  { id: "r3", empId: "e07", kind: "休日出勤", date: dayBefore(-4), detail: "10:00 → 16:00（6時間）", reason: "本番環境の移行作業", submitted: dayBefore(1), initial: "pending" },
  { id: "r4", empId: "e12", kind: "打刻修正", date: dayBefore(2), detail: "退勤 18:02 → 19:15", reason: "退勤打刻を忘れたため", submitted: dayBefore(1), initial: "pending" },
  { id: "r5", empId: "e05", kind: "残業申請", date: dayBefore(0), detail: "18:00 → 21:00（3時間）", reason: "月末提案書の仕上げ", submitted: dayBefore(0), initial: "pending" },
  { id: "r6", empId: "e10", kind: "有給申請", date: dayBefore(-14), detail: "全日 1日", reason: "通院のため", submitted: dayBefore(2), initial: "pending" },
  { id: "r7", empId: "e02", kind: "打刻修正", date: dayBefore(3), detail: "出勤 9:41 → 9:05", reason: "打刻端末の不具合", submitted: dayBefore(3), initial: "approved" },
  { id: "r8", empId: "e16", kind: "有給申請", date: dayBefore(5), detail: "午後半休 0.5日", reason: "私用のため", submitted: dayBefore(6), initial: "approved" },
];

export const empById = (id: string): Employee => EMPLOYEES.find((e) => e.id === id)!;
