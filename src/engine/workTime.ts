import type { DayInput, DayResult, Interval, MonthResult, Minutes } from "./types";

export const DAY_MIN = 1440;
export const LEGAL_DAILY_MIN = 8 * 60;
export const LEGAL_WEEKLY_MIN = 40 * 60;
export const NIGHT_START = 22 * 60;
export const NIGHT_END = 5 * 60;

/** 労基法34条: 6時間超で45分、8時間超で60分の休憩が必要（労働時間ベース） */
export function requiredBreakMin(workMin: Minutes): Minutes {
  if (workMin > 8 * 60) return 60;
  if (workMin > 6 * 60) return 45;
  return 0;
}

function overlap(a: Interval, b: Interval): Minutes {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** work から breaks を差し引いた実労働区間 */
function subtractBreaks(work: Interval, breaks: Interval[]): Interval[] {
  let segs: Interval[] = [{ ...work }];
  for (const br of breaks) {
    const next: Interval[] = [];
    for (const s of segs) {
      if (br.end <= s.start || br.start >= s.end) {
        next.push(s);
        continue;
      }
      if (br.start > s.start) next.push({ start: s.start, end: br.start });
      if (br.end < s.end) next.push({ start: br.end, end: s.end });
    }
    segs = next;
  }
  return segs;
}

function nightOverlap(seg: Interval): Minutes {
  // 各日の [0:00,5:00) と [22:00,24:00) に分割して二重計上を避ける
  let total = 0;
  const lastDay = Math.ceil(seg.end / DAY_MIN);
  for (let d = 0; d <= lastDay; d++) {
    const base = d * DAY_MIN;
    total += overlap(seg, { start: base, end: base + NIGHT_END });
    total += overlap(seg, { start: base + NIGHT_START, end: base + DAY_MIN });
  }
  return total;
}

export function calcDay(input: DayInput): DayResult {
  const empty: DayResult = {
    date: input.date,
    workMin: 0,
    legalInMin: 0,
    dailyOvertimeMin: 0,
    legalHolidayMin: 0,
    nightMin: 0,
  };
  const { work } = input;
  if (!work) return empty;
  if (work.end < work.start) throw new Error(`${input.date}: 退勤が出勤より前です`);

  const segs = subtractBreaks(work, input.breaks ?? []);
  const workMin = segs.reduce((s, x) => s + (x.end - x.start), 0);
  const nightMin = segs.reduce((s, x) => s + nightOverlap(x), 0);

  // 法定休日は暦日で扱う（昭23.4.5基発535）。日またぎの勤務は始業日の1日の労働だが、法定休日の暦日にかかる部分だけが休日労働になる
  const holidayMin = segs.reduce(
    (s, x) =>
      s +
      (input.isLegalHoliday ? overlap(x, { start: 0, end: DAY_MIN }) : 0) +
      (input.nextIsLegalHoliday ? overlap(x, { start: DAY_MIN, end: 2 * DAY_MIN }) : 0),
    0,
  );
  const ordinary = workMin - holidayMin;
  return {
    ...empty,
    workMin,
    legalInMin: Math.min(ordinary, LEGAL_DAILY_MIN),
    dailyOvertimeMin: Math.max(0, ordinary - LEGAL_DAILY_MIN),
    legalHolidayMin: holidayMin,
    nightMin,
  };
}

/** 'YYYY-MM-DD' → 週の開始日（既定: 月曜）の 'YYYY-MM-DD'。UTC で計算しタイムゾーン影響を排除 */
export function weekStart(date: string, weekStartsOn: 0 | 1 = 1): string {
  const d = new Date(`${date}T00:00:00Z`);
  const diff = (d.getUTCDay() - weekStartsOn + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/**
 * 月次集計。
 * 週40時間超は「週の実労働（法定休日労働を除く）− その週の日単位時間外 − 40時間」で算出する。
 * 週は渡された days の範囲でのみ集計するため、月初・月末の週をまたぐ場合は
 * 呼び出し側で前後の日も含めて渡し、対象月だけ後で絞ること。
 */
export function calcMonth(inputs: DayInput[], weekStartsOn: 0 | 1 = 1): MonthResult {
  const days = inputs.map(calcDay);

  const weeks = new Map<string, { work: Minutes; dailyOt: Minutes }>();
  for (const d of days) {
    const key = weekStart(d.date, weekStartsOn);
    const w = weeks.get(key) ?? { work: 0, dailyOt: 0 };
    w.work += d.workMin - d.legalHolidayMin;
    w.dailyOt += d.dailyOvertimeMin;
    weeks.set(key, w);
  }
  let weeklyOvertimeMin = 0;
  for (const w of weeks.values()) {
    weeklyOvertimeMin += Math.max(0, w.work - w.dailyOt - LEGAL_WEEKLY_MIN);
  }

  const sum = (f: (d: DayResult) => Minutes) => days.reduce((s, d) => s + f(d), 0);
  const overtimeMin = sum((d) => d.dailyOvertimeMin) + weeklyOvertimeMin;
  return {
    days,
    workMin: sum((d) => d.workMin),
    overtimeMin,
    weeklyOvertimeMin,
    legalHolidayMin: sum((d) => d.legalHolidayMin),
    nightMin: sum((d) => d.nightMin),
    overtimeOver60hMin: Math.max(0, overtimeMin - 60 * 60),
  };
}
