import type { DayInput, DayResult, Minutes } from "./types";
import { calcDay, LEGAL_DAILY_MIN, LEGAL_WEEKLY_MIN, weekStart } from "./workTime";

/**
 * 変形労働時間制・フレックスタイム制の時間外労働の計算。
 *
 * 変形期間（清算期間）の全日を日付順に並べて渡す。まだ来ていない日も含める（勤務の実績が無いだけの日として扱う）。
 * 時間外は「発生した日」に割り当てる（累計がしきい値を超えた日）。累計は減らないので、期間の途中でも、そこまでの時間外は確定した値になる。
 * 休日労働（法定休日の暦日にかかる部分）は、時間外の計算に含めない。
 */

export interface PeriodDayInput extends DayInput {
  /** その日に定められた所定労働時間（分）。定めのない日・休日は 0 */
  scheduledMin?: Minutes;
}

export interface PeriodDayResult extends DayResult {
  /** この日に新たに発生した、週単位の時間外 */
  weeklyOvertimeMin: Minutes;
  /** この日に新たに発生した、期間（総枠）単位の時間外 */
  periodOvertimeMin: Minutes;
  /** この日に発生した時間外の合計（日・週・期間） */
  overtimeMin: Minutes;
}

export interface PeriodResult {
  days: PeriodDayResult[];
  /** 法定労働時間の総枠（週の法定労働時間 × 期間の日数 ÷ 7） */
  frameMin: Minutes;
  /** 期間内の実労働（法定休日労働を除く） */
  ordinaryMin: Minutes;
}

export interface PeriodOptions {
  weekStartsOn?: 0 | 1;
  /** 週の法定労働時間（既定 40時間。特例措置対象事業場は 44時間） */
  weeklyLegalMin?: Minutes;
}

/** 法定労働時間の総枠。1分未満は切り捨てる（例: 31日で 177.1 時間） */
export const frameOf = (days: number, weeklyLegalMin: Minutes = LEGAL_WEEKLY_MIN): Minutes => Math.floor((weeklyLegalMin * days) / 7);

const finish = (r: DayResult, ordinary: Minutes, daily: Minutes, weekly: Minutes, period: Minutes): PeriodDayResult => ({
  ...r,
  legalInMin: Math.max(0, ordinary - daily - weekly - period),
  dailyOvertimeMin: daily,
  weeklyOvertimeMin: weekly,
  periodOvertimeMin: period,
  overtimeMin: daily + weekly + period,
});

/**
 * 変形労働時間制（1か月単位・1年単位・1週間単位）。次の3段階で、重複しないように数える。
 *  1. 日: 8時間を超える所定労働時間を定めた日はその時間、それ以外の日は8時間を超えた分
 *  2. 週: 週の所定労働時間が40時間を超える週はその時間、それ以外の週は40時間を超えた分（日の時間外を除く）。期間の途中から始まる・途中で終わる週は、この判定をしない
 *  3. 期間: 法定労働時間の総枠を超えた分（日・週の時間外を除く）
 */
export function calcVariablePeriod(inputs: PeriodDayInput[], opts: PeriodOptions = {}): PeriodResult {
  const weeklyLegal = opts.weeklyLegalMin ?? LEGAL_WEEKLY_MIN;
  const startsOn = opts.weekStartsOn ?? 1;
  const keyOf = (date: string) => weekStart(date, startsOn);

  const weeks = new Map<string, { sched: Minutes; days: number; cum: Minutes; counted: Minutes }>();
  for (const d of inputs) {
    const k = keyOf(d.date);
    const w = weeks.get(k) ?? { sched: 0, days: 0, cum: 0, counted: 0 };
    w.sched += d.scheduledMin ?? 0;
    w.days++;
    weeks.set(k, w);
  }

  const frameMin = frameOf(inputs.length, weeklyLegal);
  let cum = 0;
  let countedPeriod = 0;
  let ordinaryMin = 0;
  const days = inputs.map((input) => {
    const r = calcDay(input);
    const ordinary = r.workMin - r.legalHolidayMin;
    ordinaryMin += ordinary;
    const threshold = Math.max(LEGAL_DAILY_MIN, input.scheduledMin ?? 0);
    const daily = Math.max(0, ordinary - threshold);

    const w = weeks.get(keyOf(input.date))!;
    let weekly = 0;
    if (w.days === 7) {
      w.cum += ordinary - daily;
      weekly = Math.max(0, w.cum - Math.max(weeklyLegal, w.sched)) - w.counted;
      w.counted += weekly;
    }

    cum += ordinary - daily - weekly;
    const period = Math.max(0, cum - frameMin) - countedPeriod;
    countedPeriod += period;
    return finish(r, ordinary, daily, weekly, period);
  });
  return { days, frameMin, ordinaryMin };
}

export interface FlexOptions {
  weeklyLegalMin?: Minutes;
  /** 日付 → 月の区分（清算期間が1か月を超えるとき、月ごとの上限を判定する単位）。既定は暦月 */
  groupOf?: (date: string) => string;
}

/**
 * フレックスタイム制。日・週の時間外はなく、清算期間の法定労働時間の総枠を超えた分が時間外になる。
 * 清算期間が1か月を超える場合は、これに加えて、各月の労働が週平均50時間を超えた分をその月の時間外とする（総枠の超過とは重複しない）。
 */
export function calcFlexPeriod(inputs: DayInput[], opts: FlexOptions = {}): PeriodResult {
  const weeklyLegal = opts.weeklyLegalMin ?? LEGAL_WEEKLY_MIN;
  const groupOf = opts.groupOf ?? ((d: string) => d.slice(0, 7));
  const groups = new Map<string, { days: number; cum: Minutes; counted: Minutes }>();
  for (const d of inputs) {
    const g = groups.get(groupOf(d.date)) ?? { days: 0, cum: 0, counted: 0 };
    g.days++;
    groups.set(groupOf(d.date), g);
  }
  const multi = groups.size > 1;

  const frameMin = frameOf(inputs.length, weeklyLegal);
  let cum = 0;
  let countedPeriod = 0;
  let ordinaryMin = 0;
  const days = inputs.map((input) => {
    const r = calcDay(input);
    const ordinary = r.workMin - r.legalHolidayMin;
    ordinaryMin += ordinary;

    let monthly = 0;
    if (multi) {
      const g = groups.get(groupOf(input.date))!;
      g.cum += ordinary;
      monthly = Math.max(0, g.cum - Math.floor((50 * 60 * g.days) / 7)) - g.counted;
      g.counted += monthly;
    }
    cum += ordinary - monthly;
    const period = Math.max(0, cum - frameMin) - countedPeriod;
    countedPeriod += period;
    // 月ごとの上限の超過は「週」の欄ではなく期間の欄にまとめて持つ（内訳の意味が違うため、合計だけを使う）
    return finish(r, ordinary, 0, 0, monthly + period);
  });
  return { days, frameMin, ordinaryMin };
}
