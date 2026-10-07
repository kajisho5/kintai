/** 年次有給休暇の付与日数（労基法39条）。 */

/** 通常の労働者（週5日以上 or 週30時間以上）。勤続6か月, 1.5, 2.5, ... 6.5年以上 */
const FULL_TIME = [10, 11, 12, 14, 16, 18, 20] as const;

/** 比例付与（週所定労働日数ごと。週30時間未満のみ）。厚労省の付与日数表 */
const PROPORTIONAL: Record<1 | 2 | 3 | 4, readonly number[]> = {
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
};

export interface GrantInput {
  /** 付与基準日時点の継続勤務月数 */
  monthsOfService: number;
  /** 週所定労働日数 */
  weeklyDays: number;
  /** 週所定労働時間 */
  weeklyHours: number;
  /** 直前1年間の出勤率（全労働日に対する出勤日の割合, 0〜1）。8割未満は付与なし */
  attendanceRate: number;
}

export function grantDays(input: GrantInput): number {
  const { monthsOfService, weeklyDays, weeklyHours, attendanceRate } = input;
  if (monthsOfService < 6 || attendanceRate < 0.8) return 0;
  const idx = Math.min(6, Math.floor((monthsOfService - 6) / 12));
  const proportional = weeklyHours < 30 && weeklyDays <= 4;
  if (!proportional) return FULL_TIME[idx]!;
  if (weeklyDays < 1) return 0;
  return PROPORTIONAL[weeklyDays as 1 | 2 | 3 | 4][idx]!;
}

/** 年5日の取得義務（付与日数10日以上の労働者）。取得済み日数から残りの義務日数を返す */
export function remainingObligation(grantedDays: number, takenDays: number): number {
  if (grantedDays < 10) return 0;
  return Math.max(0, 5 - takenDays);
}
