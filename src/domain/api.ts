/** API の入出力の型（サーバーとフロントで共有） */
import type { Alert, DayResult, Interval } from "../engine";
import type { DayPlan, LeaveInfo, Outlook, PeriodInfo, PunchKind, Risk, RiskLevel, Role, TodayRow, WorkStyle } from "./types";

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
    /** 管理者のメールアドレスを確認済みか */
    emailVerified: boolean;
    /** 管理者のみ・未確認のときだけ: 確認メールの送り先 */
    adminEmail?: string;
  };
  settings: { fyStartMonth: number; specialClause: boolean; closingDay: number };
  /** 今日が属する勤怠の月（締め日があれば、締め日の翌日以降は翌月分） */
  currentYm: string;
  /** 祝日データが古く、来年の祝日が未登録になりそう */
  holidaysStale: boolean;
}

export interface MonthSummary {
  /** 時間外・深夜・法定休日は、会社の設定により月合計を30分単位で丸めた値（日別の合計とは一致しないことがある） */
  rounded?: boolean;
  workDays: number;
  leaveDays: number;
  absentDays: number;
  incompleteDays: number;
  workMin: number;
  legalInMin: number;
  overtimeMin: number;
  weeklyOvertimeMin: number;
  /** 変形期間・清算期間の総枠を超えた時間外（変形労働時間制・フレックスタイム制のみ） */
  periodOvertimeMin: number;
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
  /** 対象月の期間（締め日があれば、前月の締め日の翌日〜当月の締め日） */
  range: { from: string; to: string };
  months: string[];
  today: string;
  currentYm: string;
  rows: AttendanceRow[];
}

export interface AttendanceDetailResponse {
  emp: EmpBrief & { weeklyDays: number; weeklyHours: number; workStyle: WorkStyle };
  ym: string;
  /** 対象月の期間（締め日があれば、前月の締め日の翌日〜当月の締め日） */
  range: { from: string; to: string };
  months: string[];
  today: string;
  currentYm: string;
  month: MonthSummary;
  /** 変形労働時間制・フレックスタイム制の社員の、変形期間・清算期間の状況 */
  period?: PeriodInfo;
  /** 位置情報の確認で、打刻場所の範囲外（out）・位置情報なし（unknown）だった日（位置情報の設定が有効なときだけ） */
  geoFlags: Record<string, "out" | "unknown">;
  risk: Risk;
  series: { ym: string; actual: number; proj: number }[];
  days: { plan: DayPlan; result?: DayResult }[];
}

// ---------------------------------------------------------------- シフト（勤務予定）

export interface ScheduleView {
  empId: string;
  date: string;
  kind: "work" | "off" | "legal_off";
  start?: number;
  end?: number;
  breakMin: number;
}

export interface ScheduleResponse {
  ym: string;
  today: string;
  holidays: Record<string, string>;
  /** 勤務区分が変形・フレックスの社員は、シフトの入力が必要（先頭に並べる） */
  employees: (EmpBrief & { workStyle: WorkStyle; workDays: number[]; baseMin: number; schedStart: number })[];
  rows: ScheduleView[];
}

export type ScheduleItem =
  | { empId: string; date: string; kind: "work"; start: number; end: number; breakMin: number }
  | { empId: string; date: string; kind: "off" | "legal_off" | "clear" };

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
  /** 進行中の勤務の始業日。日またぎの勤務中は昨日の日付 */
  date: string;
  /** 始業日の 0:00 から見た、今日の 0:00 の位置（日またぎの勤務中は 1440、そうでなければ 0） */
  offsetMin: number;
  /** 始業日の 0:00 からの現在時刻（日またぎなら 1440 以上） */
  nowMin: number;
  events: { in?: number; out?: number; breaks: Interval[]; openBreak?: number };
  day: DayResult;
  monthOvertimeMin: number;
  outlook: Outlook;
  riskLevel: RiskLevel;
  leaveRemaining: number;
  /** 位置情報による打刻場所の確認。required のとき、打刻には位置情報が必要 */
  geo: { mode: "off" | "record" | "enforce"; required: boolean };
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
  workStyle: WorkStyle;
  /** 位置情報による打刻場所の制限を受けない（在宅勤務・外回りなど） */
  geoExempt: boolean;
  /** 共用端末で使う打刻用の暗証番号（PIN）を発行済みか */
  hasPin: boolean;
  /** 共用端末で使う ICカードを登録済みか */
  hasCard: boolean;
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

/** シフトの取り込み結果（一時パスワードはない） */
export type ScheduleImportResponse = Exclude<ImportResponse, { dryRun: false }> | { ok: true; dryRun: false; count: number };

export interface HolidayRow {
  date: string;
  name: string;
  kind: "national" | "company";
}

export interface GeoSite {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export interface SettingsResponse {
  company: { name: string; code: string };
  specialClause: boolean;
  fyStartMonth: number;
  /** 法定休日の曜日（0=日曜〜6=土曜） */
  legalHolidayDow: number;
  /** 週の法定労働時間が44時間（特例措置対象事業場） */
  week44: boolean;
  /** フレックスタイム制の清算期間（月数）と、区切りの起点月 */
  flexMonths: number;
  flexStartMonth: number;
  /** 1年単位の変形期間の起点月 */
  yearlyStartMonth: number;
  /** 位置情報による打刻場所の確認（off=しない / record=記録し、範囲外を知らせる / enforce=範囲外では打刻できない） */
  geoMode: "off" | "record" | "enforce";
  geoSites: GeoSite[];
  /** 時間外・休日・深夜の月合計の端数処理（none=しない / month30=30分未満切捨・以上切上） */
  rounding: "none" | "month30";
  /** 勤怠の締め日（0 = 月末締め）。20 なら前月21日〜当月20日を当月分とする */
  closingDay: number;
  /** フレックスタイム制のコアタイム（0:00 からの分）。なければ未設定 */
  flexCoreStart?: number;
  flexCoreEnd?: number;
  holidays: HolidayRow[];
  holidaysStale: boolean;
}

// ---------------------------------------------------------------- 請求

export interface BillingInfo {
  /** 課金機能が設定済みか（未設定の環境では申し込みできない） */
  configured: boolean;
  state: AccessState;
  trialDaysLeft?: number;
  trialEndsAt: number;
  seatsUsed: number;
  pricePerSeatJpy: number;
  /** 現在の人数での月額（税抜） */
  monthlyEstimateJpy: number;
  /** 管理者のメールアドレスを確認済みか（未確認だとお申し込みできない） */
  emailVerified: boolean;
  hasSubscription: boolean;
  /** 支払い遅延の猶予が終わる日時（遅延中のみ） */
  graceEndsAt?: number;
}

// ---------------------------------------------------------------- 共用の打刻端末（キオスク）

export interface KioskTerminal {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
  revoked: boolean;
}

export interface KioskHello {
  company: string;
  terminal: string;
  /** 会社のタイムゾーンでの今日と、今の時刻（0:00 からの分） */
  today: string;
  nowMin: number;
  /** false のとき、契約の状態により打刻できない */
  writable: boolean;
}

export interface KioskIdentified {
  ticket: string;
  emp: { id: string; name: string; dept: string };
  /** いま押せる打刻 */
  allowed: PunchKind[];
  /** 打刻の状況（出勤前・勤務中・休憩中・退勤済） */
  phase: "before" | "working" | "break" | "done";
  /** 今日（日またぎなら始業日）の出勤・退勤の時刻（0:00 からの分。25:00 は 1500） */
  events: { in?: number; out?: number };
}

export interface KioskPunched {
  emp: { id: string; name: string };
  action: PunchKind;
  /** 記録した時刻（0:00 からの分。日またぎの勤務への打刻は 1440 以上） */
  at: number;
}
