import type { Minutes } from "./types";

/** 36協定の上限規制（労基法36条）。時間は分で保持。 */
const H = 60;

export interface MonthlyTotals {
  /** 'YYYY-MM' */
  month: string;
  /** 法定時間外労働（休日労働を含まない） */
  overtimeMin: Minutes;
  /** 法定休日労働 */
  legalHolidayMin: Minutes;
}

export type AlertCode =
  | "MONTH_OVER_45H" // 原則: 月45時間
  | "YEAR_OVER_360H" // 原則: 年360時間
  | "MONTH_OVER_45H_COUNT" // 特別条項: 月45時間超は年6回まで
  | "YEAR_OVER_720H" // 特別条項: 年720時間
  | "MONTH_100H_OR_MORE" // 時間外+休日が単月100時間以上（常に違反）
  | "AVG_OVER_80H"; // 2〜6か月平均が80時間超（時間外+休日, 常に違反）

export interface Alert {
  code: AlertCode;
  level: "warning" | "violation";
  month: string;
  message: string;
}

export interface CheckOptions {
  /** 特別条項付き36協定を締結しているか */
  hasSpecialClause: boolean;
  /** 上限に対して何割で warning を出すか（既定 0.8） */
  warnRatio?: number;
}

/**
 * history は対象月を最後の要素とした時系列（古い→新しい）。
 * 年の集計は history の末尾から「同一協定期間」ぶんだけを渡すこと（協定の起算日は呼び出し側で切る）。
 * 2〜6か月平均の判定には直近6か月ぶんが必要。
 */
export function check36(history: MonthlyTotals[], opts: CheckOptions): Alert[] {
  const warnRatio = opts.warnRatio ?? 0.8;
  const alerts: Alert[] = [];
  const cur = history[history.length - 1];
  if (!cur) return alerts;
  const month = cur.month;
  const push = (code: AlertCode, level: Alert["level"], message: string) =>
    alerts.push({ code, level, month, message });

  // --- 常に適用される上限（時間外+休日労働） ---
  const combined = cur.overtimeMin + cur.legalHolidayMin;
  if (combined >= 100 * H) {
    push("MONTH_100H_OR_MORE", "violation", "時間外+休日労働が月100時間以上です（法違反）");
  } else if (combined >= 100 * H * warnRatio) {
    push("MONTH_100H_OR_MORE", "warning", "時間外+休日労働が月100時間に近づいています");
  }

  let worst: { n: number; level: "warning" | "violation" } | undefined;
  for (let n = 2; n <= Math.min(6, history.length); n++) {
    const win = history.slice(-n);
    const avg = win.reduce((s, m) => s + m.overtimeMin + m.legalHolidayMin, 0) / n;
    if (avg > 80 * H) {
      worst = { n, level: "violation" };
      break;
    }
    if (avg > 80 * H * warnRatio && !worst) worst = { n, level: "warning" };
  }
  if (worst) {
    push(
      "AVG_OVER_80H",
      worst.level,
      worst.level === "violation"
        ? `直近${worst.n}か月の時間外+休日労働の平均が80時間を超えています`
        : `直近${worst.n}か月の平均が80時間に近づいています`,
    );
  }

  // --- 月45時間 / 年360時間（原則）、特別条項（年720時間・年6回） ---
  const year = history.reduce((s, m) => s + m.overtimeMin, 0);
  const over45Count = history.filter((m) => m.overtimeMin > 45 * H).length;

  // 月45時間: 特別条項なしは違反。特別条項ありでも超過は「適用」として知らせる（年6回まで）
  if (cur.overtimeMin > 45 * H) {
    if (!opts.hasSpecialClause) push("MONTH_OVER_45H", "violation", "時間外労働が月45時間を超えています");
    else push("MONTH_OVER_45H", "warning", `月45時間を超えています（特別条項の適用 年${over45Count}回目／年6回まで）`);
  } else if (cur.overtimeMin > 45 * H * warnRatio) {
    push("MONTH_OVER_45H", "warning", "時間外労働が月45時間に近づいています");
  }

  if (!opts.hasSpecialClause) {
    if (year > 360 * H) push("YEAR_OVER_360H", "violation", "時間外労働が年360時間を超えています");
    else if (year > 360 * H * warnRatio) push("YEAR_OVER_360H", "warning", "時間外労働が年360時間に近づいています");
  } else {
    if (over45Count > 6) push("MONTH_OVER_45H_COUNT", "violation", "月45時間超が年6回を超えています");
    else if (over45Count === 6 && cur.overtimeMin > 45 * H) push("MONTH_OVER_45H_COUNT", "warning", "月45時間超が年6回に達しました（次月以降は45時間以内に）");
    if (year > 720 * H) push("YEAR_OVER_720H", "violation", "時間外労働が年720時間を超えています");
    else if (year > 720 * H * warnRatio) push("YEAR_OVER_720H", "warning", "時間外労働が年720時間に近づいています");
  }

  return alerts;
}
