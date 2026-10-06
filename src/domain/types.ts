import type { Alert, Interval, MonthResult } from "../engine";

export type Role = "admin" | "employee";

/** 勤務区分。fixed=通常 / monthly=1か月単位の変形 / yearly=1年単位の変形 / weekly=1週間単位の変形 / flex=フレックスタイム制 */
export type WorkStyle = "fixed" | "monthly" | "yearly" | "weekly" | "flex";

export const WORK_STYLES: readonly WorkStyle[] = ["fixed", "monthly", "yearly", "weekly", "flex"];

export const WORK_STYLE_LABEL: Record<WorkStyle, string> = {
  fixed: "通常（固定時間制）",
  monthly: "1か月単位の変形労働時間制",
  yearly: "1年単位の変形労働時間制",
  weekly: "1週間単位の変形労働時間制",
  flex: "フレックスタイム制",
};

/** シフト（勤務予定）の1日分。work=勤務 / off=休み / legal_off=法定休日として指定した休み */
export interface ScheduleRow {
  empId: string;
  date: string;
  kind: "work" | "off" | "legal_off";
  /** 勤務の開始・終了（その日の 0:00 からの分。翌日にまたがる場合は 1440 以上） */
  start?: number;
  end?: number;
  breakMin: number;
}

export interface Employee {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
  role: Role;
  workStyle: WorkStyle;
  /** 所定労働日（0=日〜6=土） */
  workDays: number[];
  weeklyDays: number;
  weeklyHours: number;
  /** 所定の実働分（休憩除く） */
  baseMin: number;
  /** 所定の始業時刻（0:00 からの分） */
  schedStart: number;
  hired: string;
  /** 前年度からの繰越有給日数 */
  carry: number;
  email?: string;
  /** 退職日（この日まで在籍）。在職中は未設定 */
  leftOn?: string;
  /** 次回ログイン時にパスワード変更を求める（管理者が発行した一時パスワードのとき） */
  mustChangePassword?: boolean;
}

export type PunchKind = "in" | "out" | "break_start" | "break_end";

export interface PunchEvent {
  empId: string;
  date: string;
  kind: PunchKind;
  /** その日の 0:00 からの経過分 */
  min: number;
  /** 記録順（同じ種類が複数あれば後勝ち） */
  seq: number;
}

export interface LeaveRow {
  empId: string;
  date: string;
  /** 1 = 全日, 0.5 = 半休 */
  days: number;
}

export interface Calendar {
  /** 会社のタイムゾーンでの今日 (YYYY-MM-DD) */
  today: string;
  /** 今日の 0:00 からの経過分（日またぎの勤務が勤務中かの判定に使う。省略時は判定しない） */
  nowMin?: number;
  holidays: Record<string, string>;
}

export type DayKind = "work" | "leave" | "off" | "absent" | "incomplete";

export interface DayPlan {
  date: string;
  kind: DayKind;
  start?: number;
  end?: number;
  breaks: Interval[];
  isLegalHoliday?: boolean;
  nextIsLegalHoliday?: boolean;
  note?: string;
}

/** 変形期間・清算期間の進み具合（変形労働時間制・フレックスタイム制の社員のみ） */
export interface PeriodInfo {
  style: WorkStyle;
  start: string;
  end: string;
  /** 法定労働時間の総枠（期間全体） */
  frameMin: number;
  /** 前日までの実労働（法定休日労働を除く） */
  workMin: number;
  /** 期間全体の所定労働時間 */
  contractMin: number;
  /** 前日までの所定労働時間 */
  contractSoFarMin: number;
  /** 期間内に、ここまでに発生した時間外 */
  overtimeMin: number;
  /** 期間の残り日数（本日を含む） */
  remainingDays: number;
}

export interface LedgerOptions {
  specialClause: boolean;
  fiscalStartMonth?: number;
  /** 法定休日の曜日（0=日曜）。シフトで法定休日を指定した週は、その日が法定休日になる */
  legalHolidayDow?: number;
  /** 勤怠の締め日（0 = 月末締め）。例: 20 → 前月21日〜当月20日を当月分とする */
  closingDay?: number;
  /** 週の法定労働時間（分）。既定 2400（40時間）。特例措置対象事業場は 2640（44時間） */
  weeklyLegalMin?: number;
  /** フレックスタイム制の清算期間（1〜3か月）と、その区切りの起点月 */
  flexMonths?: number;
  flexStartMonth?: number;
  /** 1年単位の変形期間の起点月（その月の1日から12か月） */
  yearlyStartMonth?: number;
  /** フレックスタイム制のコアタイム（0:00 からの分）。省略ならコアタイムなし */
  flexCore?: { start: number; end: number };
  schedules?: ScheduleRow[];
}

export interface MonthData {
  ym: string;
  /** 変形労働時間制・フレックスタイム制の社員の、変形期間・清算期間の状況 */
  period?: PeriodInfo;
  plans: DayPlan[];
  result: MonthResult;
  workDays: number;
  leaveDays: number;
  absentDays: number;
  incompleteDays: number;
}

export interface Outlook {
  /** 前日までの累計（時間外） */
  mtdOvertime: number;
  /** 月末見込（時間外） */
  projOvertime: number;
  holiday: number;
}

export type RiskLevel = "ok" | "warning" | "violation";

export interface Risk {
  level: RiskLevel;
  alerts: Alert[];
  yearOvertime: number;
  over45Count: number;
  outlook: Outlook;
}

export interface Bar {
  from: number;
  to: number;
  ot: boolean;
  plan: boolean;
}

/** いま進行中（または今日に入ってから終わった）勤務。日またぎの勤務は、始業日の打刻として記録されている */
export interface Shift {
  /** 始業日（打刻の日付） */
  date: string;
  /** 始業日の 0:00 から見た、今日の 0:00 の位置（始業日が昨日なら 1440） */
  offset: number;
}

export type Status = "working" | "break" | "left" | "before" | "missing" | "leave" | "off";

export interface TodayRow {
  emp: Pick<Employee, "id" | "name" | "dept" | "title" | "kind">;
  status: Status;
  note?: string;
  start?: number;
  end?: number;
  bars: Bar[];
  workedMin: number;
}

export interface LeaveInfo {
  emp: Pick<Employee, "id" | "name" | "dept" | "weeklyDays" | "hired">;
  granted: number;
  taken: number;
  planned: number;
  carry: number;
  remaining: number;
  lastGrant?: string;
  nextGrant: string;
  periodEnd?: string;
  obligationLeft: number;
  daysToDeadline?: number;
}
