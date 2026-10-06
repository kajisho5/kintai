import { dateFromDays, daysFromDate, dowOfDays } from "../engine/dates";

/** 日付はすべて 'YYYY-MM-DD' 文字列。UTC で計算しタイムゾーンの影響を受けない。 */

const utc = (date: string): Date => new Date(`${date}T00:00:00Z`);

export const dowOf = (date: string): number => {
  const n = daysFromDate(date);
  return Number.isNaN(n) ? utc(date).getUTCDay() : dowOfDays(n);
};

export function datesOfMonth(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
}

/** 36協定の協定期間の開始月。startMonth は協定の起算月（既定 4 = 4/1 起算） */
export function fiscalStartYm(date: string, startMonth = 4): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, "0")}`;
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function addMonths(date: string, n: number): string {
  const d = utc(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const days = daysFromDate(date);
  if (!Number.isNaN(days)) return dateFromDays(days + n);
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const diffDays = (a: string, b: string): number => {
  const x = daysFromDate(a);
  const y = daysFromDate(b);
  return Number.isNaN(x) || Number.isNaN(y) ? Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000) : y - x;
};

export const isYm = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s).getTime()) && utc(s).toISOString().slice(0, 10) === s;

export const lastDateOfMonth = (ym: string): string => datesOfMonth(ym)[datesOfMonth(ym).length - 1]!;

/** from〜to（両端を含む）の日付の一覧 */
export function datesBetween(from: string, to: string): string[] {
  const a = daysFromDate(from);
  const b = daysFromDate(to);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(dateFromDays(i));
  return out;
}

export function addYm(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** 1年単位の変形期間（startMonth の1日から12か月）のうち、date を含むもの */
export function yearlyPeriod(date: string, startMonth: number): { start: string; end: string } {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const start = `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, "0")}-01`;
  return { start, end: addDays(addMonths(start, 12), -1) };
}

/** フレックスタイム制の清算期間（startMonth の1日から months か月ずつ区切る）のうち、date を含むもの */
export function flexPeriod(date: string, startMonth: number, months: number): { start: string; end: string } {
  const ym = date.slice(0, 7);
  const m = Number(ym.slice(5, 7));
  const back = (((m - startMonth) % 12) + 12) % 12 % months;
  const startYm = addYm(ym, -back);
  return { start: `${startYm}-01`, end: lastDateOfMonth(addYm(startYm, months - 1)) };
}

// ---------------------------------------------------------------- 締め日（月の区切り）

/**
 * 勤怠の月の区切り。0 = 月末締め（暦月）。1〜28 = その日に締める。
 * 例: 20日締めの「2026年10月分」は、2026-09-21〜2026-10-20。
 */
export type ClosingDay = number;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 月（ym）の期間。月末締めなら暦月、締め日があれば前月の締め日の翌日から当月の締め日まで */
export function periodOfYm(ym: string, closing: ClosingDay = 0): { start: string; end: string } {
  if (!closing) return { start: `${ym}-01`, end: lastDateOfMonth(ym) };
  return { start: addDays(`${addYm(ym, -1)}-${pad2(closing)}`, 1), end: `${ym}-${pad2(closing)}` };
}

export const datesOfPeriod = (ym: string, closing: ClosingDay = 0): string[] => {
  const p = periodOfYm(ym, closing);
  return datesBetween(p.start, p.end);
};

/** 日付が属する月（締め日の翌日以降は、翌月分） */
export function ymOfDate(date: string, closing: ClosingDay = 0): string {
  const ym = date.slice(0, 7);
  return closing && Number(date.slice(8)) > closing ? addYm(ym, 1) : ym;
}

/** 1年単位の変形期間（startMonth 分から12か月）のうち、月 ym を含むもの */
export function yearlyPeriodOfYm(ym: string, startMonth: number, closing: ClosingDay = 0): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const startYm = `${m >= startMonth ? y : y - 1}-${pad2(startMonth)}`;
  return { start: periodOfYm(startYm, closing).start, end: periodOfYm(addYm(startYm, 11), closing).end };
}

/** フレックスタイム制の清算期間（startMonth 分から months か月ずつ）のうち、月 ym を含むもの */
export function flexPeriodOfYm(ym: string, startMonth: number, months: number, closing: ClosingDay = 0): { start: string; end: string } {
  const m = Number(ym.slice(5, 7));
  const back = ((((m - startMonth) % 12) + 12) % 12) % months;
  const startYm = addYm(ym, -back);
  return { start: periodOfYm(startYm, closing).start, end: periodOfYm(addYm(startYm, months - 1), closing).end };
}
