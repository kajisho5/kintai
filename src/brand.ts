/**
 * 製品名・運営者情報の唯一の定義。画面・メール・規約ひな形はすべてここを参照する。
 * 製品名は「トキスケ」（ローマ字は tokisuke）。商標の調査は未実施（公開前に必須）。ロゴは brand/ と docs/brand-guidelines.md を参照。
 */
export const BRAND = {
  name: "トキスケ",
  /** 画面のタイトルやメールの署名に使う短い説明 */
  tagline: "中小企業のための勤怠管理",
  /** 運営会社（特定商取引法の表記・規約に使用）。契約前に正式な情報へ置き換えること */
  operator: {
    name: "（運営会社名）",
    representative: "（代表者名）",
    address: "（所在地）",
    email: "support@example.com",
    phone: "（電話番号）",
  },
  /** 規約のひな形に差し込む運用上の数値。事業判断と法務確認のうえで確定すること */
  policy: {
    /** 料金改定などの事前通知日数 */
    noticeDays: 30,
    /** 契約終了後、データを削除するまでの日数 */
    retentionDays: 30,
    /** 損害賠償の上限の算定に使う、直近の支払い月数 */
    liabilityMonths: 12,
  },
} as const;
