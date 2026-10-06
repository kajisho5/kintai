import type { Alert, Interval, MonthResult } from "../engine";

export type Role = "admin" | "employee";

export interface Employee {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
  role: Role;
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

export interface MonthData {
  ym: string;
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
