import { describe, expect, it } from "vitest";
import { calcDay, calcMonth, check36, grantDays, remainingObligation, requiredBreakMin, weekStart } from "./index";

const h = (x: number) => x * 60;
const t = (hh: number, mm = 0) => hh * 60 + mm;

describe("calcDay", () => {
  it("9:00-18:00 休憩1h → 実働8h、時間外なし", () => {
    const r = calcDay({ date: "2026-10-05", work: { start: t(9), end: t(18) }, breaks: [{ start: t(12), end: t(13) }] });
    expect(r.workMin).toBe(h(8));
    expect(r.legalInMin).toBe(h(8));
    expect(r.dailyOvertimeMin).toBe(0);
    expect(r.nightMin).toBe(0);
  });

  it("9:00-22:00 休憩1h → 実働12h、時間外4h、深夜0", () => {
    const r = calcDay({ date: "2026-10-05", work: { start: t(9), end: t(22) }, breaks: [{ start: t(12), end: t(13) }] });
    expect(r.workMin).toBe(h(12));
    expect(r.dailyOvertimeMin).toBe(h(4));
    expect(r.nightMin).toBe(0);
  });

  it("13:00-翌2:00 休憩1h（17-18時）→ 深夜は22:00-26:00の4h", () => {
    const r = calcDay({ date: "2026-10-05", work: { start: t(13), end: t(26) }, breaks: [{ start: t(17), end: t(18) }] });
    expect(r.workMin).toBe(h(12));
    expect(r.nightMin).toBe(h(4));
  });

  it("早朝 4:00-9:00 は 4:00-5:00 が深夜", () => {
    const r = calcDay({ date: "2026-10-05", work: { start: t(4), end: t(9) } });
    expect(r.nightMin).toBe(h(1));
  });

  it("深夜帯の休憩は深夜から控除される", () => {
    const r = calcDay({ date: "2026-10-05", work: { start: t(20), end: t(24) }, breaks: [{ start: t(22), end: t(23) }] });
    expect(r.nightMin).toBe(h(1));
    expect(r.workMin).toBe(h(3));
  });

  it("法定休日労働は時間外に含めず休日労働として計上", () => {
    const r = calcDay({ date: "2026-10-04", work: { start: t(9), end: t(20) }, breaks: [{ start: t(12), end: t(13) }], isLegalHoliday: true });
    expect(r.legalHolidayMin).toBe(h(10));
    expect(r.dailyOvertimeMin).toBe(0);
    expect(r.legalInMin).toBe(0);
  });

  it("夜勤 22:00-翌7:00 休憩1h（平日）→ 実働8h・時間外0・深夜7h", () => {
    const r = calcDay({ date: "2026-10-05", work: { start: t(22), end: t(31) }, breaks: [{ start: t(25), end: t(26) }] });
    expect(r.workMin).toBe(h(8));
    expect(r.dailyOvertimeMin).toBe(0);
    expect(r.nightMin).toBe(h(6)); // 22-25時の3h と 26-29時の3h（休憩の1hを除く）
  });

  it("法定休日の前日の夜から翌朝（土22:00→日7:00）は、日曜0:00以降の7hだけが休日労働", () => {
    const r = calcDay({ date: "2026-10-03", work: { start: t(22), end: t(31) }, nextIsLegalHoliday: true });
    expect(r.workMin).toBe(h(9));
    expect(r.legalHolidayMin).toBe(h(7));
    expect(r.legalInMin).toBe(h(2));
    expect(r.dailyOvertimeMin).toBe(0);
  });

  it("法定休日の夜から翌朝（日20:00→月6:00 休憩1h）は、日曜の4hが休日労働、月曜側の5hは通常の労働", () => {
    const r = calcDay({ date: "2026-10-04", work: { start: t(20), end: t(30) }, breaks: [{ start: t(24), end: t(25) }], isLegalHoliday: true });
    expect(r.workMin).toBe(h(9));
    expect(r.legalHolidayMin).toBe(h(4));
    expect(r.legalInMin).toBe(h(5));
  });

  it("休日の暦日にかかる部分の残りが8時間を超えれば、その分は時間外", () => {
    const r = calcDay({ date: "2026-10-03", work: { start: t(8), end: t(32) }, breaks: [{ start: t(12), end: t(13) }], nextIsLegalHoliday: true });
    // 実働23h = 土曜16h（8-24時、休憩1h除く15h）+ 日曜8h
    expect(r.legalHolidayMin).toBe(h(8));
    expect(r.legalInMin).toBe(h(8));
    expect(r.dailyOvertimeMin).toBe(h(7));
  });

  it("退勤が出勤より前ならエラー", () => {
    expect(() => calcDay({ date: "2026-10-05", work: { start: t(18), end: t(9) } })).toThrow();
  });
});

describe("requiredBreakMin", () => {
  it("6h以下0 / 6h超45 / 8h超60", () => {
    expect(requiredBreakMin(h(6))).toBe(0);
    expect(requiredBreakMin(h(6) + 1)).toBe(45);
    expect(requiredBreakMin(h(8))).toBe(45);
    expect(requiredBreakMin(h(8) + 1)).toBe(60);
  });
});

describe("weekStart", () => {
  it("月曜始まり", () => {
    expect(weekStart("2026-10-05")).toBe("2026-10-05"); // 月曜
    expect(weekStart("2026-10-11")).toBe("2026-10-05"); // 日曜
  });
});

describe("calcMonth 週40時間超", () => {
  it("週6日×7h=42h → 週超過2h（日単位超過なし）", () => {
    // 2026-10-05(月)〜10-10(土) 各7h
    const days = Array.from({ length: 6 }, (_, i) => ({
      date: `2026-10-${String(5 + i).padStart(2, "0")}`,
      work: { start: t(9), end: t(16) },
    }));
    const r = calcMonth(days);
    expect(r.workMin).toBe(h(42));
    expect(r.weeklyOvertimeMin).toBe(h(2));
    expect(r.overtimeMin).toBe(h(2));
  });

  it("日単位で既に数えた時間外は週で二重計上しない", () => {
    // 月〜金 各9h(休憩なしの実働) = 45h → 日単位超過 5h、週超過は 45-5-40=0
    const days = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-10-${String(5 + i).padStart(2, "0")}`,
      work: { start: t(9), end: t(18) },
    }));
    const r = calcMonth(days);
    expect(r.overtimeMin).toBe(h(5));
    expect(r.weeklyOvertimeMin).toBe(0);
  });

  it("法定休日労働は週40時間の計算から除外", () => {
    const days = [
      ...Array.from({ length: 5 }, (_, i) => ({
        date: `2026-10-${String(5 + i).padStart(2, "0")}`,
        work: { start: t(9), end: t(17) },
      })),
      { date: "2026-10-11", work: { start: t(9), end: t(17) }, isLegalHoliday: true },
    ];
    const r = calcMonth(days);
    expect(r.overtimeMin).toBe(0);
    expect(r.legalHolidayMin).toBe(h(8));
  });

  it("月60時間超の時間外を分離", () => {
    // 平日10日（10/5-9, 10/12-16）× 実働15h → 日単位超過 7h×10 = 70h、週超過なし
    const dates = ["05", "06", "07", "08", "09", "12", "13", "14", "15", "16"];
    const days = dates.map((d) => ({
      date: `2026-10-${d}`,
      work: { start: t(9), end: t(9) + h(15) },
    }));
    const r = calcMonth(days);
    expect(r.overtimeMin).toBe(h(70));
    expect(r.overtimeOver60hMin).toBe(h(10));
  });
});

describe("grantDays", () => {
  const base = { weeklyDays: 5, weeklyHours: 40, attendanceRate: 0.9 };
  it("通常労働者の付与日数", () => {
    expect(grantDays({ ...base, monthsOfService: 5 })).toBe(0);
    expect(grantDays({ ...base, monthsOfService: 6 })).toBe(10);
    expect(grantDays({ ...base, monthsOfService: 18 })).toBe(11);
    expect(grantDays({ ...base, monthsOfService: 30 })).toBe(12);
    expect(grantDays({ ...base, monthsOfService: 42 })).toBe(14);
    expect(grantDays({ ...base, monthsOfService: 54 })).toBe(16);
    expect(grantDays({ ...base, monthsOfService: 66 })).toBe(18);
    expect(grantDays({ ...base, monthsOfService: 78 })).toBe(20);
    expect(grantDays({ ...base, monthsOfService: 200 })).toBe(20);
  });
  it("出勤率8割未満は付与なし", () => {
    expect(grantDays({ ...base, monthsOfService: 18, attendanceRate: 0.79 })).toBe(0);
  });
  it("比例付与（週3日・週20h）", () => {
    const p = { weeklyDays: 3, weeklyHours: 20, attendanceRate: 1 };
    expect(grantDays({ ...p, monthsOfService: 6 })).toBe(5);
    expect(grantDays({ ...p, monthsOfService: 42 })).toBe(8);
  });
  it("週4日でも週30h以上なら通常付与", () => {
    expect(grantDays({ monthsOfService: 6, weeklyDays: 4, weeklyHours: 32, attendanceRate: 1 })).toBe(10);
  });
  it("年5日取得義務", () => {
    expect(remainingObligation(10, 2)).toBe(3);
    expect(remainingObligation(10, 6)).toBe(0);
    expect(remainingObligation(7, 0)).toBe(0);
  });
});

describe("check36", () => {
  const m = (month: string, ot: number, hol = 0) => ({ month, overtimeMin: h(ot), legalHolidayMin: h(hol) });
  it("特別条項なし: 月46hは違反", () => {
    const a = check36([m("2026-10", 46)], { hasSpecialClause: false });
    expect(a.some((x) => x.code === "MONTH_OVER_45H" && x.level === "violation")).toBe(true);
  });
  it("月45hちょうどは違反でない（警告のみ）", () => {
    const a = check36([m("2026-10", 45)], { hasSpecialClause: false });
    expect(a.every((x) => x.level === "warning")).toBe(true);
  });
  it("時間外+休日が100hちょうどは違反（100時間未満が条件）", () => {
    const a = check36([m("2026-10", 60, 40)], { hasSpecialClause: true });
    expect(a.some((x) => x.code === "MONTH_100H_OR_MORE" && x.level === "violation")).toBe(true);
  });
  it("99hは100h違反ではない", () => {
    const a = check36([m("2026-10", 60, 39)], { hasSpecialClause: true });
    expect(a.some((x) => x.code === "MONTH_100H_OR_MORE" && x.level === "violation")).toBe(false);
  });
  it("2か月平均が80h超は違反", () => {
    const a = check36([m("2026-09", 90), m("2026-10", 75)], { hasSpecialClause: true });
    expect(a.some((x) => x.code === "AVG_OVER_80H" && x.level === "violation")).toBe(true);
  });
  it("特別条項: 月45h超が7回目は違反", () => {
    const hist = Array.from({ length: 7 }, (_, i) => m(`2026-${String(4 + i).padStart(2, "0")}`, 50));
    const a = check36(hist, { hasSpecialClause: true });
    expect(a.some((x) => x.code === "MONTH_OVER_45H_COUNT" && x.level === "violation")).toBe(true);
  });
  it("特別条項: 年720h超は違反", () => {
    const hist = Array.from({ length: 12 }, (_, i) => m(`${i}`, 61));
    const a = check36(hist, { hasSpecialClause: true });
    expect(a.some((x) => x.code === "YEAR_OVER_720H" && x.level === "violation")).toBe(true);
  });
  it("特別条項あり: 月46hは違反ではなく適用の通知（warning）", () => {
    const a = check36([m("2026-10", 46)], { hasSpecialClause: true });
    const month = a.find((y) => y.code === "MONTH_OVER_45H");
    expect(month?.level).toBe("warning");
    expect(a.some((y) => y.level === "violation")).toBe(false);
  });
  it("特別条項あり: 月40hは45hへの接近を警告", () => {
    const a = check36([m("2026-10", 40)], { hasSpecialClause: true });
    expect(a.some((y) => y.code === "MONTH_OVER_45H" && y.level === "warning")).toBe(true);
  });
  it("月30hは警告なし", () => {
    expect(check36([m("2026-10", 30)], { hasSpecialClause: true })).toEqual([]);
  });
});
