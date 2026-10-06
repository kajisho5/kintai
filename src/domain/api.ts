/** API の入出力の型（サーバーとフロントで共有） */
import type { Alert, DayResult, Interval } from "../engine";
import type { DayPlan, LeaveInfo, Outlook, Risk, RiskLevel, Role, TodayRow } from "./types";

export interface EmpBrief {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
}

export type AccessState = "trialing" | "trial_expired" | "active" | "past_due" | "canceled" | "suspended";

export interface MeResponse {
  employee: EmpBrief & { role: Role };
  today: string;
  nowMin: number;
  /** 管理者のみ: 承認待ちの件数 */
  pending: number;
  /** 管理者が発行した一時パスワードのまま。変更するまで他の操作はできない */
  mustChangePassword: boolean;
  tenant: {
    code: string;
    name: string;
    state: AccessState;
    /** false の間は閲覧のみ（トライアル終了・解約） */
    writable: boolean;
    trialDaysLeft?: number;
    seatsUsed: number;
    seatLimit: number;
  };
  settings: { fyStartMonth: number; specialClause: boolean };
  /** 祝日データが古く、来年の祝日が未登録になりそう */
  holidaysStale: boolean;
}

export interface MonthSummary {
  workDays: number;
  leaveDays: number;
  absentDays: number;
  incompleteDays: number;
  workMin: number;
  legalInMin: number;
  overtimeMin: number;
  weeklyOvertimeMin: number;
  nightMin: number;
  holidayMin: number;
}

export interface RiskSummary {
  level: RiskLevel;
  alerts: Alert[];
  yearOvertime: number;
  over45Count: number;
  outlook: Outlook;
}

export interface AttendanceRow {
  emp: EmpBrief;
  month: MonthSummary;
  risk: RiskSummary;
  leaveRemaining: number;
}

export interface AttendanceListResponse {
  ym: string;
  months: string[];
  today: string;
  rows: AttendanceRow[];
}

export interface AttendanceDetailResponse {
  emp: EmpBrief & { weeklyDays: number; weeklyHours: number };
  ym: string;
  months: string[];
  today: string;
  month: MonthSummary;
  risk: Risk;
  series: { ym: string; actual: number; proj: number }[];
  days: { plan: DayPlan; result?: DayResult }[];
}

export interface RequestView {
  id: number;
  emp: EmpBrief;
  kind: "残業申請" | "休日出勤" | "有給申請" | "打刻修正";
  date: string;
  detail: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdDate: string;
}

export interface DashboardResponse {
  today: string;
  nowMin: number;
  headcount: number;
  rows: TodayRow[];
  watch: { emp: EmpBrief; risk: RiskSummary }[];
  watchTotal: number;
  violating: number;
  pending: RequestView[];
  pendingTotal: number;
}

export interface PunchStateResponse {
  date: string;
  nowMin: number;
  events: { in?: number; out?: number; breaks: Interval[]; openBreak?: number };
  day: DayResult;
  monthOvertimeMin: number;
  outlook: Outlook;
  riskLevel: RiskLevel;
  leaveRemaining: number;
}

export interface LeaveResponse {
  today: string;
  rows: LeaveInfo[];
}

export type NewRequest =
  | { kind: "残業申請" | "休日出勤"; date: string; start: number; end: number; reason: string }
  | { kind: "有給申請"; date: string; days: 1 | 0.5; reason: string }
  | { kind: "打刻修正"; date: string; in?: number; out?: number; reason: string };

// ---------------------------------------------------------------- 社員管理・会社設定（管理者）

export interface EmployeeAdmin {
  id: string;
  name: string;
  dept: string;
  title: string;
  kind: "正社員" | "パート";
  role: Role;
  email?: string;
  workDays: number[];
  weeklyDays: number;
  weeklyHours: number;
  baseMin: number;
  schedStart: number;
  hired: string;
  carry: number;
  active: boolean;
  leftOn?: string;
  mustChangePassword: boolean;
}

export type EmployeeInput = Omit<EmployeeAdmin, "active" | "leftOn" | "mustChangePassword" | "weeklyDays" | "weeklyHours"> & {
  weeklyDays?: number;
  weeklyHours?: number;
};

export interface EmployeesResponse {
  rows: EmployeeAdmin[];
  seatsUsed: number;
  seatLimit: number;
}

export interface ImportRowError {
  /** CSV の行番号（見出し行が 1） */
  row: number;
  message: string;
}

export type ImportResponse =
  | { ok: false; errors: ImportRowError[] }
  | { ok: true; dryRun: true; count: number }
  | { ok: true; dryRun: false; count: number; credentials: { id: string; name: string; tempPassword: string }[] };

export interface HolidayRow {
  date: string;
  name: string;
  kind: "national" | "company";
}

export interface SettingsResponse {
  company: { name: string; code: string };
  specialClause: boolean;
  fyStartMonth: number;
  holidays: HolidayRow[];
  holidaysStale: boolean;
}
