import { describe, expect, it } from "vitest";
import { Ledger, addDays, dowOf, type Employee, type PunchEvent, type ScheduleRow, type WorkStyle, type LedgerOptions } from "./index";

const base: Employee = {
  id: "x1", name: "テスト 太郎", dept: "開発部", title: "", kind: "正社員", role: "employee", workStyle: "fixed",
  workDays: [1, 2, 3, 4, 5], weeklyDays: 5, weeklyHours: 40, baseMin: 480, schedStart: 540, hired: "2020-04-01", carry: 0,
};
const as = (style: WorkStyle, over: Partial<Employee> = {}): Employee => ({ ...base, workStyle: style, ...over });

let seq = 0;
/** 9:00 から len 分（休憩なし）の勤務 */
const work = (date: string, len: number, start = 9 * 60): PunchEvent[] => [
  { empId: "x1", date, kind: "in", min: start, seq: ++seq },
  { empId: "x1", date, kind: "out", min: start + len, seq: ++seq },
];
const shift = (date: string, start: number, end: number, breakMin = 0): ScheduleRow => ({ empId: "x1", date, kind: "work", start, end, breakMin });
const off = (date: string, kind: "off" | "legal_off" = "off"): ScheduleRow => ({ empId: "x1", date, kind, breakMin: 0 });
const ledger = (events: PunchEvent[], opts: Partial<LedgerOptions> = {}, today = "2026-10-20") =>
  new Ledger({ today, holidays: {} }, events, [], { specialClause: true, ...opts });

const range = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const h = (x: number) => x * 60;

describe("1か月単位の変形労働時間制（Ledger）", () => {
  // 10/5(月)〜10/8(木) は所定10時間（9:00-19:00、休憩なし）、金は所定8時間
  const sched = range("2026-10-05", "2026-10-09").map((d) => (dowOf(d) <= 4 ? shift(d, h(9), h(19)) : shift(d, h(9), h(17))));
  const events = range("2026-10-05", "2026-10-08").flatMap((d) => work(d, h(10)));

  it("所定どおり10時間働いても、通常の社員なら日の時間外になるが、変形の社員なら時間外にならない", () => {
    const fixed = ledger(events, { schedules: sched }).monthOf(as("fixed"), "2026-10").result;
    const monthly = ledger(events, { schedules: sched }).monthOf(as("monthly"), "2026-10").result;
    expect(fixed.overtimeMin).toBe(h(8)); // 2時間 × 4日
    expect(monthly.overtimeMin).toBe(0);
    expect(monthly.workMin).toBe(h(40));
  });

  it("日の時間外は、所定を超えた分。時間外は発生した日の行に付く", () => {
    const l = ledger([...events, ...work("2026-10-09", h(9) + 30)], { schedules: sched });
    const rows = l.dayRows(as("monthly"), "2026-10");
    const fri = rows.find((r) => r.plan.date === "2026-10-09")!;
    // 金曜の所定は8時間。9.5時間働くと、1.5時間のうち日の時間外は 1.5時間（所定8時間 → 8時間超が日の時間外）
    expect(fri.result!.dailyOvertimeMin).toBe(h(1) + 30);
    expect(l.monthOf(as("monthly"), "2026-10").result.overtimeMin).toBe(h(1) + 30);
  });

  it("変形期間の状況（総枠・実労働・所定）を返す", () => {
    const m = ledger(events, { schedules: sched }).monthOf(as("monthly"), "2026-10");
    expect(m.period).toMatchObject({ style: "monthly", start: "2026-10-01", end: "2026-10-31", frameMin: 10628, workMin: h(40) });
    expect(m.period!.contractMin).toBe(h(10) * 4 + h(8) + 22 * h(8) - 5 * h(8)); // シフトのある5日 + 平日の残り17日
  });

  it("月末見込は、これまでのペースで残りの予定を働いたものとして計算する", () => {
    // 10/1〜10/19 の平日（所定8時間）に毎日9時間働いてきた社員（日の時間外が毎日1時間）
    const days = range("2026-10-01", "2026-10-19").filter((d) => dowOf(d) >= 1 && dowOf(d) <= 5);
    const ev = days.flatMap((d) => work(d, h(9)));
    const l = ledger(ev, {});
    const o = l.outlookOf(as("monthly"), "2026-10", ["2026-10"]);
    expect(o.mtdOvertime).toBe(days.length * h(1));
    // 残りの平日（10/20〜10/30）も同じペース（所定の9/8倍）で働くとして、日ごとに1時間ずつ増える
    const remaining = range("2026-10-20", "2026-10-31").filter((d) => dowOf(d) >= 1 && dowOf(d) <= 5).length;
    expect(o.projOvertime).toBeGreaterThanOrEqual(o.mtdOvertime + remaining * h(1) - 5);
  });
});

describe("1年単位の変形労働時間制（Ledger）", () => {
  it("期間（4月始まり）の途中の月でも、日・週の時間外はその日・週に付き、月をまたぐ週も扱える", () => {
    // 9/28(月)〜10/2(金) と 10/3(土)に働く。週の所定は40時間
    const sched = range("2026-09-28", "2026-10-02").map((d) => shift(d, h(9), h(17)));
    const ev = [...range("2026-09-28", "2026-10-02").flatMap((d) => work(d, h(8))), ...work("2026-10-03", h(4))];
    const l = ledger(ev, { schedules: sched, yearlyStartMonth: 4 });
    const e = as("yearly");
    expect(l.monthOf(e, "2026-10").result.overtimeMin).toBe(h(4)); // 土曜の4時間が週の時間外（10月に発生）
    expect(l.monthOf(e, "2026-09").result.overtimeMin).toBe(0);
    expect(l.monthOf(e, "2026-10").period).toMatchObject({ start: "2026-04-01", end: "2027-03-31", frameMin: 125142 });
  });

  it("36協定の限度は月42時間・年320時間で判定される", () => {
    // 毎日（月〜金）10時間 + 土曜は無し: 日の時間外のしきい値は8時間（所定8時間のシフト）。10月に42時間を超える時間外
    const days = range("2026-10-01", "2026-10-19").filter((d) => dowOf(d) >= 1 && dowOf(d) <= 5);
    const ev = days.flatMap((d) => work(d, h(12)));
    const l = ledger(ev, { specialClause: false });
    const risk = l.riskOf(as("yearly"), "2026-10");
    expect(risk.alerts.some((a) => a.message.includes("月42時間"))).toBe(true);
    const fixedRisk = ledger(ev, { specialClause: false }).riskOf(as("fixed"), "2026-10");
    expect(fixedRisk.alerts.some((a) => a.message.includes("月42時間"))).toBe(false);
  });
});

describe("1週間単位の変形労働時間制（Ledger）", () => {
  it("週ごとに40時間で判定する。所定10時間×4日の週は時間外なし", () => {
    const sched = range("2026-10-05", "2026-10-08").map((d) => shift(d, h(9), h(19)));
    const ev = range("2026-10-05", "2026-10-08").flatMap((d) => work(d, h(10)));
    const l = ledger(ev, { schedules: sched });
    expect(l.monthOf(as("weekly"), "2026-10").result.overtimeMin).toBe(0);
    // 金曜に2時間追加で働くと、週の合計が42時間 → 2時間が時間外
    const l2 = ledger([...ev, ...work("2026-10-09", h(2))], { schedules: sched });
    expect(l2.monthOf(as("weekly"), "2026-10").result.overtimeMin).toBe(h(2));
  });
});

describe("フレックスタイム制（Ledger）", () => {
  it("日8時間を超えても時間外にならず、清算期間の総枠を超えた分だけが時間外になる", () => {
    // 10/1〜10/19 の平日13日、毎日10時間 = 130時間。総枠177:08にはまだ届かない
    const days = range("2026-10-01", "2026-10-19").filter((d) => dowOf(d) >= 1 && dowOf(d) <= 5);
    const l = ledger(days.flatMap((d) => work(d, h(10))));
    const m = l.monthOf(as("flex"), "2026-10");
    expect(m.result.overtimeMin).toBe(0);
    expect(m.result.workMin).toBe(days.length * h(10));
    expect(m.period).toMatchObject({ style: "flex", frameMin: 10628, workMin: days.length * h(10), contractSoFarMin: days.length * h(8) });
    // 月末見込: 残り12日（所定8時間）も同じペース（10/8倍）で働くと、月の総労働は 22日×10時間 = 220時間 → 総枠超過 42:52
    const o = l.outlookOf(as("flex"), "2026-10", ["2026-10"]);
    expect(o.mtdOvertime).toBe(0);
    expect(o.projOvertime).toBeGreaterThan(h(40));
    expect(o.projOvertime).toBeLessThan(h(44));
  });

  it("清算期間が3か月なら、各月の期間（4月始まり）をまたいで総枠を計算する。コアタイムに満たない勤務には注記が付く", () => {
    const ev = [...work("2026-10-01", h(8), h(11))]; // 11:00出勤
    const l = ledger(ev, { flexMonths: 3, flexStartMonth: 4, flexCore: { start: h(10), end: h(15) } });
    const m = l.monthOf(as("flex"), "2026-10");
    expect(m.period).toMatchObject({ start: "2026-10-01", end: "2026-12-31", frameMin: Math.floor((2400 * 92) / 7) });
    expect(m.plans.find((p) => p.date === "2026-10-01")!.note).toBe("コアタイム外");
  });
});

describe("法定休日とシフト", () => {
  const sun = "2026-10-04";
  it("既定は日曜が法定休日。出勤すれば休日労働", () => {
    const m = ledger(work(sun, h(4))).monthOf(base, "2026-10").result;
    expect(m.legalHolidayMin).toBe(h(4));
    expect(m.overtimeMin).toBe(0);
  });

  it("シフトで週の法定休日を水曜に指定した週は、日曜に働いても休日労働ではなく通常の労働（週40時間を超えれば時間外）", () => {
    const sched = [off("2026-10-07", "legal_off")];
    const ev = [...range("2026-10-05", "2026-10-09").filter((d) => d !== "2026-10-07").flatMap((d) => work(d, h(8))), ...work(sun, h(4))];
    const m = ledger(ev, { schedules: sched }).monthOf(base, "2026-10").result;
    expect(m.legalHolidayMin).toBe(0);
    // 週（日曜始まりの暦週 10/4〜10/10）の合計: 日曜4時間 + 月・火・木・金の4日×8時間 = 36時間。40時間以内なので時間外なし
    expect(m.overtimeMin).toBe(0);
    // 同じ週で、法定休日の指定が水曜でも、水曜に働けば休日労働
    const wed = ledger([...ev, ...work("2026-10-07", h(5))], { schedules: sched }).monthOf(base, "2026-10").result;
    expect(wed.legalHolidayMin).toBe(h(5));
  });

  it("法定休日の曜日を会社の設定で変えられる（土曜）", () => {
    const sat = "2026-10-10";
    const sun = "2026-10-11";
    expect(ledger(work(sat, h(4)), { legalHolidayDow: 6 }).monthOf(base, "2026-10").result.legalHolidayMin).toBe(h(4));
    expect(ledger(work(sun, h(4)), { legalHolidayDow: 6 }).monthOf(base, "2026-10").result.legalHolidayMin).toBe(0);
  });

  it("シフトの休みの日は欠勤にならず、シフトのある日に打刻がなければ欠勤になる。祝日でもシフトがあれば勤務日", () => {
    const sched = [off("2026-10-08"), shift("2026-10-10", h(9), h(17))]; // 木曜を休み、土曜を勤務に
    const l = new Ledger({ today: "2026-10-20", holidays: { "2026-10-12": "スポーツの日" } }, [], [], { specialClause: true, schedules: [...sched, shift("2026-10-12", h(9), h(17))] });
    expect(l.planOf(base, "2026-10-08")).toMatchObject({ kind: "off", note: "休み" });
    expect(l.planOf(base, "2026-10-09").kind).toBe("absent");
    expect(l.planOf(base, "2026-10-10").kind).toBe("absent"); // 土曜だがシフトがある
    expect(l.planOf(base, "2026-10-12").kind).toBe("absent"); // 祝日だがシフトがある
  });

  it("本日の「打刻なし」の判定と予定の帯は、シフトの開始時刻・時間を使う", () => {
    const l = new Ledger({ today: "2026-10-06", holidays: {} }, [], [], { specialClause: true, schedules: [shift("2026-10-06", h(22), h(31), 60)] });
    const night = as("monthly", { schedStart: h(9) });
    expect(l.todayRow(night, h(22) + 10).status).toBe("before");
    expect(l.todayRow(night, h(22) + 30).status).toBe("missing");
    expect(l.todayRow(night, h(9) + 30).status).toBe("before"); // 朝の9:30は、シフト（22時開始）のずっと前
  });
});

describe("締め日（月の区切り）", () => {
  const closing20 = { closingDay: 20 };
  it("20日締めの10月分は 9/21〜10/20。その期間の打刻だけが集計される", () => {
    const ev = [...work("2026-09-20", h(10)), ...work("2026-09-21", h(10)), ...work("2026-10-20", h(10)), ...work("2026-10-21", h(10))];
    const l = ledger(ev, closing20, "2026-11-05");
    const oct = l.monthOf(base, "2026-10");
    expect(oct.plans[0]!.date).toBe("2026-09-21");
    expect(oct.plans[oct.plans.length - 1]!.date).toBe("2026-10-20");
    expect(oct.workDays).toBe(2); // 9/21 と 10/20
    expect(oct.result.overtimeMin).toBe(h(4));
    expect(l.monthOf(base, "2026-11").plans[0]!.date).toBe("2026-10-21");
    expect(l.monthOf(base, "2026-09").workDays).toBe(1); // 9/20
  });

  it("今日が締め日の翌日以降なら、「当月」は翌月分になる。月末締めなら暦月のまま", () => {
    expect(ledger([], closing20, "2026-10-20").currentYm).toBe("2026-10");
    expect(ledger([], closing20, "2026-10-21").currentYm).toBe("2026-11");
    expect(ledger([], {}, "2026-10-31").currentYm).toBe("2026-10");
  });

  it("月末見込・フレックスの総枠・1年単位の期間も、締め日の区切りで計算される", () => {
    // 20日締めの10月分 = 9/21〜10/20（30日）。フレックスの総枠 = floor(2400 × 30 / 7)
    const l = ledger([], closing20, "2026-10-05");
    const m = l.monthOf(as("flex"), "2026-10");
    expect(m.period).toMatchObject({ start: "2026-09-21", end: "2026-10-20", frameMin: Math.floor((2400 * 30) / 7) });
    const y = ledger([], closing20, "2026-10-05").monthOf(as("yearly"), "2026-10");
    expect(y.period).toMatchObject({ start: "2026-03-21", end: "2027-03-20" }); // 4月分 = 3/21〜4/20 から12か月
  });
});
