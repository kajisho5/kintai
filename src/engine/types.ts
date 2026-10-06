/** 時刻は「勤務日の 0:00 からの経過分」。翌日にまたがる場合は 1440 以上を使う（例: 翌2:00 = 1560）。 */
export type Minutes = number;

export interface Interval {
  start: Minutes;
  end: Minutes;
}

export interface DayInput {
  /** YYYY-MM-DD */
  date: string;
  /** 出退勤。未打刻の日は省略 */
  work?: Interval;
  /** 実際に取った休憩（労働時間から控除） */
  breaks?: Interval[];
  /** 法定休日（週1回/4週4回）の労働か */
  isLegalHoliday?: boolean;
}

export interface DayResult {
  date: string;
  /** 休憩控除後の実労働分 */
  workMin: Minutes;
  /** 法定内労働（日8時間以内。法定休日労働は含まない） */
  legalInMin: Minutes;
  /** 日単位の法定時間外（1日8時間超。法定休日労働は含まない） */
  dailyOvertimeMin: Minutes;
  /** 法定休日労働 */
  legalHolidayMin: Minutes;
  /** 深夜労働（22:00-翌5:00。他の区分と重複カウントされる） */
  nightMin: Minutes;
}

export interface MonthResult {
  days: DayResult[];
  workMin: Minutes;
  /** 法定時間外 = 日単位超過 + 週40時間超過（法定休日労働は含まない） */
  overtimeMin: Minutes;
  weeklyOvertimeMin: Minutes;
  legalHolidayMin: Minutes;
  nightMin: Minutes;
  /** 月60時間を超える時間外（割増率50%以上の対象） */
  overtimeOver60hMin: Minutes;
}
