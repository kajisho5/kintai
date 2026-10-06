/** 日付はすべて 'YYYY-MM-DD' 文字列。UTC で計算しタイムゾーンの影響を受けない。 */

const utc = (date: string): Date => new Date(`${date}T00:00:00Z`);

export const dowOf = (date: string): number => utc(date).getUTCDay();

export function datesOfMonth(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
}

/** 協定期間（4/1 起算）の開始月 */
export function fiscalStartYm(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-04`;
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
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const diffDays = (a: string, b: string): number => Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000);

export const isYm = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s).getTime()) && utc(s).toISOString().slice(0, 10) === s;
