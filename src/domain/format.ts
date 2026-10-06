export const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

export const durJa = (m: number): string => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h && r ? `${h}時間${r}分` : h ? `${h}時間` : `${r}分`;
};

/** 端数処理の方法。none=しない / month30=1か月の合計の1時間未満の端数を、30分未満は切り捨て・30分以上は切り上げ */
export type Rounding = "none" | "month30";

/**
 * 1か月の時間外・休日・深夜の各合計に1時間未満の端数があるとき、30分未満を切り捨て、30分以上を1時間に切り上げる。
 * 賃金計算を簡便にするための処理として、通達（昭63.3.14基発150）で認められている。1日ごとや打刻ごとの丸めは認められない。
 */
export const roundMonthTotal = (min: number, mode: Rounding): number => (mode === "month30" ? Math.floor(min / 60) * 60 + (min % 60 >= 30 ? 60 : 0) : min);
