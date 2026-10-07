import { describe, expect, it } from "vitest";
import { calcFlexPeriod, calcVariablePeriod, frameOf, type PeriodDayInput } from "./index";

const h = (x: number) => x * 60;
const dates = (from: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** 期間の全日を作る。worked(date) が分を返せば、その長さ（休憩込みで開始9:00から）の勤務があったことにする */
function period(from: string, n: number, worked: (d: string) => number, sched: (d: string) => number = () => 0): PeriodDayInput[] {
  return dates(from, n).map((date) => {
    const w = worked(date);
    return { date, work: w > 0 ? { start: h(9), end: h(9) + w } : undefined, scheduledMin: sched(date) };
  });
}
const sum = (r: { days: { overtimeMin: number }[] }) => r.days.reduce((s, d) => s + d.overtimeMin, 0);
const field = (r: { days: object[] }, k: string) => r.days.reduce((s, d) => s + ((d as Record<string, number>)[k] ?? 0), 0);

describe("法定労働時間の総枠", () => {
  it("40時間 × 日数 ÷ 7（1分未満は切り捨て）。31日は177.1時間、28日は160時間", () => {
    expect(frameOf(31)).toBe(10628); // 177時間08分
    expect(frameOf(28)).toBe(h(160));
    expect(frameOf(365)).toBe(125142);
    expect(frameOf(31, h(44))).toBe(11691);
  });
});

describe("1か月単位の変形労働時間制（2026年10月）", () => {
  const weekday = (d: string) => dow(d) >= 1 && dow(d) <= 5;

  it("所定10時間の日は10時間を超えた分だけが時間外。8時間を超えても10時間までは時間外にならない", () => {
    // 月〜木が所定10時間（週40時間）。10月5日（月）に11時間働く
    const r = calcVariablePeriod(period("2026-10-01", 31, (d) => (d === "2026-10-05" ? h(11) + 60 : 0), (d) => (["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].includes(d) ? h(10) : 0)));
    // 休憩60分を引いても実働は11時間→ 11 - 10 = 1時間（休憩は calcDay に渡していないので 12時間 - 10時間 = 2時間）
    expect(r.days.find((d) => d.date === "2026-10-05")!.dailyOvertimeMin).toBe(h(12) - h(10));
  });

  it("所定6時間の日に8時間を超えて働いたときは、8時間超が日の時間外。6〜8時間は日の時間外にならない", () => {
    const sched = (d: string) => (weekday(d) ? h(6) : 0);
    const a = calcVariablePeriod(period("2026-10-01", 31, (d) => (d === "2026-10-06" ? h(8) : 0), sched));
    expect(sum(a)).toBe(0); // 8時間ちょうどなら、日の時間外はない
    const b = calcVariablePeriod(period("2026-10-01", 31, (d) => (d === "2026-10-06" ? h(9) : 0), sched));
    expect(b.days.find((d) => d.date === "2026-10-06")!.dailyOvertimeMin).toBe(h(1));
  });

  it("週の所定が40時間なら、40時間を超えた分が週の時間外。発生した日（週の累計が40時間を超えた日）に付く", () => {
    // 10/5(月)〜10/9(金) 各8時間 + 10/10(土) 4時間 → 週44時間
    const r = calcVariablePeriod(period("2026-10-01", 31, (d) => (d >= "2026-10-05" && d <= "2026-10-09" ? h(8) : d === "2026-10-10" ? h(4) : 0), (d) => (d >= "2026-10-05" && d <= "2026-10-09" ? h(8) : 0)));
    expect(field(r, "weeklyOvertimeMin")).toBe(h(4));
    expect(r.days.find((d) => d.date === "2026-10-10")!.weeklyOvertimeMin).toBe(h(4));
    expect(r.days.find((d) => d.date === "2026-10-09")!.overtimeMin).toBe(0);
    expect(sum(r)).toBe(h(4));
  });

  it("週の所定が40時間を超える週は、所定を超えた分だけが時間外（所定どおりなら時間外なし）", () => {
    // 10/5(月)〜10/10(土) 所定 8×5 + 6 = 46時間。そのとおりに働く → 週40時間は超えるが時間外ではない
    const sched = (d: string) => (d >= "2026-10-05" && d <= "2026-10-09" ? h(8) : d === "2026-10-10" ? h(6) : 0);
    const asScheduled = calcVariablePeriod(period("2026-10-01", 31, sched, sched));
    expect(field(asScheduled, "weeklyOvertimeMin")).toBe(0);
    // 土曜に1時間余計に働くと、その1時間が週の時間外
    const more = calcVariablePeriod(period("2026-10-01", 31, (d) => (d === "2026-10-10" ? h(7) : sched(d)), sched));
    expect(field(more, "weeklyOvertimeMin")).toBe(h(1));
  });

  it("期間の途中から始まる週・途中で終わる週は、週の判定をせず、期間の総枠で判定する", () => {
    // 10/1(木)〜10/2(金)と、10/31(土) の部分週に働く。週の判定はされない
    const r = calcVariablePeriod(period("2026-10-01", 31, (d) => (weekday(d) ? h(8) : d === "2026-10-03" || d === "2026-10-31" ? h(4) : 0), (d) => (weekday(d) ? h(8) : 0)));
    // 平日22日×8h=176h + 土曜2日×4h(部分週) + 完全な週の土曜(10,17,24)3日×4h は週の時間外
    expect(field(r, "weeklyOvertimeMin")).toBe(0); // 完全な週に土曜勤務は無い
    expect(r.ordinaryMin).toBe(h(176) + h(8));
    // 184時間 − 総枠 177時間08分 = 6時間52分
    expect(field(r, "periodOvertimeMin")).toBe(h(184) - 10628);
  });

  it("日・週・期間の時間外は重複して数えない", () => {
    // 毎週月〜土を毎日9時間（所定8時間×月〜金+土は所定0）で働く月
    const r = calcVariablePeriod(period("2026-10-01", 31, (d) => (dow(d) >= 1 && dow(d) <= 6 ? h(9) : 0), (d) => (weekday(d) ? h(8) : 0)));
    const total = r.ordinaryMin;
    // 日の時間外: 平日は9-8=1時間、土曜は9-8=1時間 → 日ごとに1時間
    const workedDays = dates("2026-10-01", 31).filter((d) => dow(d) >= 1 && dow(d) <= 6).length;
    expect(field(r, "dailyOvertimeMin")).toBe(h(1) * workedDays);
    // 重複させずに数えたとき、時間外の合計は「全労働 − 法定内」を超えない
    expect(sum(r)).toBeLessThanOrEqual(total);
    expect(sum(r)).toBe(field(r, "dailyOvertimeMin") + field(r, "weeklyOvertimeMin") + field(r, "periodOvertimeMin"));
  });

  it("法定休日の労働は、時間外の計算に含めない", () => {
    const days = period("2026-10-01", 31, (d) => (weekday(d) ? h(8) : d === "2026-10-04" ? h(10) : 0), (d) => (weekday(d) ? h(8) : 0)).map((x) => (x.date === "2026-10-04" ? { ...x, isLegalHoliday: true } : x));
    const r = calcVariablePeriod(days);
    expect(r.days.find((d) => d.date === "2026-10-04")!.legalHolidayMin).toBe(h(10));
    expect(sum(r)).toBe(0);
    expect(r.ordinaryMin).toBe(h(176));
  });

  it("週の法定労働時間が44時間（特例措置対象事業場）なら、総枠・週の判定も44時間", () => {
    const sched = (d: string) => (d >= "2026-10-05" && d <= "2026-10-09" ? h(8) : 0);
    const r44 = calcVariablePeriod(period("2026-10-01", 31, (d) => (d === "2026-10-10" ? h(4) : sched(d)), sched), { weeklyLegalMin: h(44) });
    expect(field(r44, "weeklyOvertimeMin")).toBe(0); // 40+4=44 は超えない
    const r40 = calcVariablePeriod(period("2026-10-01", 31, (d) => (d === "2026-10-10" ? h(4) : sched(d)), sched));
    expect(field(r40, "weeklyOvertimeMin")).toBe(h(4));
  });

  it("まだ来ていない日が含まれていても、これまでの時間外は確定した値になる（累計は減らない）", () => {
    const worked = (d: string) => (d >= "2026-10-05" && d <= "2026-10-09" ? h(8) : d === "2026-10-10" ? h(4) : 0);
    const sched = (d: string) => (d >= "2026-10-05" && d <= "2026-10-09" ? h(8) : 0);
    const upToSat = calcVariablePeriod(period("2026-10-01", 31, worked, sched));
    const later = calcVariablePeriod(period("2026-10-01", 31, (d) => (d > "2026-10-10" ? 0 : worked(d)), sched));
    expect(sum(later)).toBe(sum(upToSat));
  });
});

describe("1年単位の変形労働時間制", () => {
  it("総枠は365日で2085.7時間（40×365÷7）。超えた分は、超えた日に時間外として付く", () => {
    // 毎日（週7日）6時間 = 年2190時間 → 総枠 2085.7時間を超える分は、累計が枠を超えた日から。週・日の判定では超えない（週42時間 > 40 かつ所定42時間）
    const sched = () => h(6);
    const r = calcVariablePeriod(period("2026-04-01", 365, () => h(6), sched));
    expect(r.frameMin).toBe(125142);
    expect(field(r, "dailyOvertimeMin")).toBe(0);
    expect(field(r, "weeklyOvertimeMin")).toBe(0);
    expect(field(r, "periodOvertimeMin")).toBe(h(6) * 365 - 125142);
    const first = r.days.findIndex((d) => d.periodOvertimeMin > 0);
    expect(first).toBeGreaterThan(300); // 期間の終わりに近い日から発生する
  });
});

describe("フレックスタイム制", () => {
  it("清算期間1か月: 総枠（10月は177時間08分）を超えた分だけが時間外。日の8時間・週の40時間は関係ない", () => {
    // 平日に 9時間15分ずつ（22日 = 203.5時間）。1日9時間超でも日の時間外にはならない
    const r = calcFlexPeriod(period("2026-10-01", 31, (d) => (dow(d) >= 1 && dow(d) <= 5 ? h(9) + 15 : 0)));
    expect(field(r, "dailyOvertimeMin")).toBe(0);
    expect(sum(r)).toBe(22 * (h(9) + 15) - 10628);
  });

  it("総枠に満たなければ時間外は0（不足分は繰り越さず、時間外にもならない）", () => {
    const r = calcFlexPeriod(period("2026-10-01", 31, (d) => (dow(d) >= 1 && dow(d) <= 5 ? h(7) : 0)));
    expect(sum(r)).toBe(0);
    expect(r.ordinaryMin).toBe(22 * h(7));
  });

  it("清算期間3か月: 各月が週平均50時間を超えた分は、その月の時間外。総枠の超過とは重複しない", () => {
    // 10〜12月（92日）。総枠 = floor(2400×92/7) = 31542分（525時間42分）。10月の上限 = floor(3000×31/7) = 13285分（221時間25分）
    const r = calcFlexPeriod(period("2026-10-01", 92, (d) => (dow(d) >= 1 && dow(d) <= 5 ? (d < "2026-11-01" ? h(10) + 30 : h(7)) : 0)));
    const oct = r.days.filter((d) => d.date < "2026-11-01").reduce((s, d) => s + d.overtimeMin, 0);
    const wd = (from: string, to: string) => dates(from, Math.round((Date.parse(to) - Date.parse(from)) / 86400000)).filter((d) => dow(d) >= 1 && dow(d) <= 5).length;
    const octWork = wd("2026-10-01", "2026-11-01") * (h(10) + 30);
    expect(oct).toBe(octWork - 13285); // 10月の超過分（月の上限）
    const total = r.ordinaryMin;
    // 全体では、(月の超過を除いた累計) が総枠を超えなければ、期間の時間外は月の超過だけ
    expect(sum(r)).toBe(Math.max(oct, 0) + Math.max(0, total - oct - 31542));
  });

  it("清算期間3か月: 各月が上限以内でも、期間全体が総枠を超えればその分が時間外（最後に総枠を超えた日に付く）", () => {
    const r = calcFlexPeriod(period("2026-10-01", 92, (d) => (dow(d) >= 1 && dow(d) <= 5 ? h(9) : 0)));
    // 平日 = 10月22日+11月21日+12月23日 = 66日 × 9時間 = 594時間。各月は週平均50時間（221h/214h/228h）以内
    const wk = dates("2026-10-01", 92).filter((d) => dow(d) >= 1 && dow(d) <= 5).length;
    expect(sum(r)).toBe(wk * h(9) - 31542);
    const last = [...r.days].reverse().find((d) => d.overtimeMin > 0)!;
    expect(last.date >= "2026-12-01").toBe(true);
  });

  it("法定休日の労働は総枠の計算に含めない", () => {
    const days = period("2026-10-01", 31, (d) => (dow(d) >= 1 && dow(d) <= 5 ? h(8) : d === "2026-10-04" ? h(8) : 0)).map((x) => (x.date === "2026-10-04" ? { ...x, isLegalHoliday: true } : x));
    const r = calcFlexPeriod(days);
    expect(r.ordinaryMin).toBe(22 * h(8));
    expect(sum(r)).toBe(0);
  });
});
