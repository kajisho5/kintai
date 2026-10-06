/**
 * 製品名・運営者情報の唯一の定義。画面・メール・規約ひな形はすべてここを参照する。
 * 「Kintai」は仮名。正式名称を決めたらここを書き換える（商標の事前調査を推奨）。
 */
export const BRAND = {
  name: "Kintai",
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
} as const;
