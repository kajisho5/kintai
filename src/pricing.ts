/**
 * 料金・利用制限。価格は仮置き（事業判断で変更する）。
 * 競合の目安: ジョブカン 200円〜、KING OF TIME 300円、freee勤怠管理Plus 300円〜（いずれも1人/月）。
 */
export const PLAN = {
  trialDays: 30,
  trialSeatLimit: 30,
  /** 1人あたり月額（税抜） */
  pricePerSeatJpy: 300,
  /** 有料プランの上限人数（これ以上は個別相談） */
  paidSeatLimit: 1000,
  /** 支払い失敗後も使い続けられる猶予日数 */
  pastDueGraceDays: 14,
} as const;
