import { describe, expect, it } from "vitest";
import { Ledger, barsFor, deriveDay, type Employee, type PunchEvent } from "./index";

const emp: Employee = {
  id: "x1", name: "テスト 太郎", dept: "開発部", title: "", kind: "正社員", role: "employee",
  workDays: [1, 2, 3, 4, 5], weeklyDays: 5, weeklyHours: 40, baseMin: 480, schedStart: 540, hired: "2020-04-01", carry: 0,
};
let seq = 0;
const ev = (date: string, kind: PunchEvent["kind"], hh: number, mm = 0): PunchEvent => ({ empId: "x1", date, kind, min: hh * 60 + mm, seq: ++seq });
const day = (date: string, out = 18) => [ev(date, "in", 9), ev(date, "break_start", 12), ev(date, "break_end", 13), ev(date, "out", out)];
const ledger = (events: PunchEvent[], leaves: { empId: string; date: string; days: number }[] = [], today = "2026-10-06") =>
  new Ledger({ today, holidays: { "2026-10-12": "スポーツの日" } }, events, leaves, { specialClause: true });

describe("deriveDay", () => {
  it("同種の打刻は後勝ち（修正が上書きできる）", () => {
    const d = deriveDay([ev("2026-10-05", "in", 9), ev("2026-10-05", "out", 18), ev("2026-10-05", "out", 19)]);
    expect(d.in).toBe(540);
    expect(d.out).toBe(1140);
  });
  it("休憩の開始と終了を対にし、閉じていない休憩は openBreak に残す", () => {
    const d = deriveDay([ev("2026-10-05", "in", 9), ev("2026-10-05", "break_start", 12), ev("2026-10-05", "break_end", 13), ev("2026-10-05", "break_start", 15)]);
    expect(d.breaks).toEqual([{ start: 720, end: 780 }]);
    expect(d.openBreak).toBe(900);
  });
});

describe("Ledger.planOf", () => {
  it("所定労働日に打刻がなければ「打刻なし（absent）」", () => {
    expect(ledger([]).planOf(emp, "2026-10-05").kind).toBe("absent");
  });
  it("休日・祝日・所定休日は off（備考付き）", () => {
    const l = ledger([]);
    expect(l.planOf(emp, "2026-10-04").note).toBe("法定休日");
    expect(l.planOf(emp, "2026-10-03").note).toBe("所定休日");
    expect(l.planOf(emp, "2026-10-12").note).toBe("スポーツの日");
  });
  it("過去日で退勤がなければ incomplete（集計に含めない）", () => {
    const l = ledger([ev("2026-10-05", "in", 9)]);
    expect(l.planOf(emp, "2026-10-05").kind).toBe("incomplete");
    expect(l.monthOf(emp, "2026-10").workDays).toBe(0);
    expect(l.monthOf(emp, "2026-10").incompleteDays).toBe(1);
  });
  it("有給は leave。半休で出勤していれば work + 備考", () => {
    const l = ledger(day("2026-10-02"), [
      { empId: "x1", date: "2026-10-01", days: 1 },
      { empId: "x1", date: "2026-10-02", days: 0.5 },
    ]);
    expect(l.planOf(emp, "2026-10-01").kind).toBe("leave");
    const half = l.planOf(emp, "2026-10-02");
    expect(half.kind).toBe("work");
    expect(half.note).toBe("半休");
    expect(l.monthOf(emp, "2026-10").leaveDays).toBe(1.5);
  });
  it("日曜の出勤は法定休日労働として集計される", () => {
    const l = ledger([ev("2026-10-04", "in", 10), ev("2026-10-04", "out", 16)]);
    const m = l.monthOf(emp, "2026-10");
    expect(m.result.legalHolidayMin).toBe(360);
    expect(m.result.overtimeMin).toBe(0);
  });
  it("入社日より前は集計対象外", () => {
    const l = ledger([], [], "2026-10-06");
    const newbie = { ...emp, hired: "2026-10-05" };
    expect(l.monthOf(newbie, "2026-10").plans.map((p) => p.date)).toEqual(["2026-10-05"]);
  });
});

describe("Ledger 月次・本日", () => {
  it("時間外は日8時間超の合計になる", () => {
    const l = ledger([...day("2026-10-01", 20), ...day("2026-10-02", 19)]);
    const m = l.monthOf(emp, "2026-10");
    expect(m.workDays).toBe(2);
    expect(m.result.overtimeMin).toBe(120 + 60);
  });
  it("本日の行: 勤務中・休憩中・退勤済・打刻なしを区別する", () => {
    const today = "2026-10-06";
    expect(ledger([ev(today, "in", 9)]).todayRow(emp, 10 * 60).status).toBe("working");
    expect(ledger([ev(today, "in", 9), ev(today, "break_start", 12)]).todayRow(emp, 12 * 60 + 10).status).toBe("break");
    expect(ledger(day(today)).todayRow(emp, 19 * 60).status).toBe("left");
    expect(ledger([]).todayRow(emp, 9 * 60 + 5).status).toBe("before");
    expect(ledger([]).todayRow(emp, 10 * 60).status).toBe("missing");
  });
  it("本日の集計は現在時刻までで計算する", () => {
    const l = ledger([ev("2026-10-06", "in", 9)]);
    expect(l.todayResult(emp, 11 * 60).workMin).toBe(120);
  });
});

describe("半休の予定", () => {
  it("午前半休（13:00出勤）の予定は所定の半分（17:00）で終わる", () => {
    const today = "2026-10-06";
    const l = ledger([ev(today, "in", 13)], [{ empId: "x1", date: today, days: 0.5 }]);
    const row = l.todayRow(emp, 14 * 60);
    expect(row.bars[row.bars.length - 1]!.to).toBe(17 * 60);
  });
});

describe("barsFor", () => {
  it("8時間を超えた部分が時間外、現在より先が予定になる", () => {
    const bars = barsFor(540, 1140, [{ start: 720, end: 780 }], 1020); // 9:00-19:00, 休憩12-13, 現在17:00
    expect(bars.find((b) => b.ot)?.from).toBe(1080); // 3h + 5h = 8h に達する 18:00 から時間外
    expect(bars.filter((b) => b.plan).every((b) => b.from >= 1020)).toBe(true);
    expect(bars.reduce((s, b) => s + b.to - b.from, 0)).toBe(540); // 実働9時間
  });
});
