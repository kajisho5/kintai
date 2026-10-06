/**
 * 日付（'YYYY-MM-DD'）の計算。Date を使わず、整数だけで計算する（大量の社員・日数を集計するとき、Date の生成が処理時間の大半を占めるため）。
 * 暦は、グレゴリオ暦（1970-01-01 を 0 とする通算日。Howard Hinnant の civil 日付のアルゴリズム）。
 */

const FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → 1970-01-01 からの通算日。形式が不正なら NaN */
export function daysFromDate(date: string): number {
  if (!FORMAT.test(date)) return NaN;
  let y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return NaN;
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** 通算日 → 'YYYY-MM-DD' */
export function dateFromDays(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** 曜日（0=日〜6=土） */
export const dowOfDays = (days: number): number => (((days + 4) % 7) + 7) % 7;
