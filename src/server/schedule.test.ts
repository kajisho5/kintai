import { beforeEach, describe, expect, it } from "vitest";
import type { AttendanceDetailResponse, EmployeesResponse, ScheduleResponse, SettingsResponse } from "../domain";
import { PASSWORD, setup } from "./testkit";

let t: ReturnType<typeof setup>;
let admin: string;
beforeEach(async () => {
  t = setup({ nowMin: 840, at: "14:00" });
  admin = await t.login("e16");
});
const post = (cookie: string, items: unknown[]) => t.call("POST", "/api/schedules", { cookie, body: { items } });
const work = (empId: string, date: string, start = 540, end = 1080, breakMin = 60) => ({ empId, date, kind: "work", start, end, breakMin });

describe("シフト（勤務予定）", () => {
  it("管理者が勤務・休み・法定休日を登録でき、月ごとに取得できる。上書き・削除もできる", async () => {
    expect((await post(admin, [work("e01", "2026-10-12", 600, 1140, 60), { empId: "e01", date: "2026-10-13", kind: "off" }, { empId: "e01", date: "2026-10-14", kind: "legal_off" }])).status).toBe(200);
    let r = (await t.call("GET", "/api/schedules?ym=2026-10", { cookie: admin })).json as ScheduleResponse;
    expect(r.rows.filter((x) => x.empId === "e01")).toEqual([
      { empId: "e01", date: "2026-10-12", kind: "work", start: 600, end: 1140, breakMin: 60 },
      { empId: "e01", date: "2026-10-13", kind: "off", breakMin: 0 },
      { empId: "e01", date: "2026-10-14", kind: "legal_off", breakMin: 0 },
    ]);
    expect(r.holidays["2026-10-12"]).toBe("スポーツの日");
    // 上書きと削除
    await post(admin, [work("e01", "2026-10-12", 1320, 1860, 60), { empId: "e01", date: "2026-10-13", kind: "clear" }]);
    r = (await t.call("GET", "/api/schedules?ym=2026-10", { cookie: admin })).json as ScheduleResponse;
    expect(r.rows.filter((x) => x.empId === "e01").map((x) => [x.date, x.start, x.end])).toEqual([["2026-10-12", 1320, 1860], ["2026-10-14", undefined, undefined]]);
    expect((await t.call("GET", "/api/schedules?ym=2026-11", { cookie: admin })).json.rows).toEqual([]);
  });

  it("一般の社員は、自分のシフトだけ見られて、変更はできない", async () => {
    await post(admin, [work("e01", "2026-10-12"), work("e02", "2026-10-12")]);
    const c = await t.login("e01");
    const r = (await t.call("GET", "/api/schedules?ym=2026-10", { cookie: c })).json as ScheduleResponse;
    expect(r.employees.map((e) => e.id)).toEqual(["e01"]);
    expect(r.rows.map((x) => x.empId)).toEqual(["e01"]);
    expect((await post(c, [work("e01", "2026-10-13")])).status).toBe(403);
  });

  it("不正な入力は拒否される（終了が開始より前・休憩が長すぎる・在籍しない社員・範囲外の日付・上限超過）", async () => {
    expect((await post(admin, [work("e01", "2026-10-12", 600, 600)])).status).toBe(400);
    expect((await post(admin, [work("e01", "2026-10-12", 600, 700, 100)])).status).toBe(400);
    expect((await post(admin, [work("e01", "2026-10-12", 0, 2000, 0)])).status).toBe(400); // 24時間超
    expect((await post(admin, [work("nobody", "2026-10-12")])).status).toBe(400);
    expect((await post(admin, [work("e01", "2020-01-01")])).status).toBe(400);
    expect((await post(admin, [work("e01", "2030-01-01")])).status).toBe(400);
    expect((await post(admin, [{ empId: "e01", date: "2026-13-40", kind: "off" }])).status).toBe(400);
    expect((await post(admin, [])).status).toBe(400);
    expect((await post(admin, Array.from({ length: 1001 }, () => work("e01", "2026-10-12")))).status).toBe(400);
    expect((await t.call("GET", "/api/schedules?ym=2030-01", { cookie: admin })).status).toBe(400);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM schedules").get()).toEqual({ n: 0 });
  });

  it("途中で不正な項目があれば、全体を取り消す（一部だけ登録されない）", async () => {
    expect((await post(admin, [work("e01", "2026-10-12"), work("e01", "2026-10-13", 600, 600)])).status).toBe(400);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM schedules").get()).toEqual({ n: 0 });
  });

  it("CSVで取り込める。確認だけ（dryRun）では登録されず、誤りは行番号つきで返る。翌日にまたがる時刻（26:00）も指定できる", async () => {
    const csv = ["社員ID,日付,区分,開始,終了,休憩（分）", "e01,2026-10-12,勤務,22:00,31:00,60", "e01,2026/10/13,休み,,,", "e02,2026-10-12,法定休日,,,"].join("\n");
    const dry = await t.call("POST", "/api/schedules/import", { cookie: admin, body: { csv, dryRun: true } });
    expect(dry.json).toEqual({ ok: true, dryRun: true, count: 3 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM schedules").get()).toEqual({ n: 0 });
    const done = await t.call("POST", "/api/schedules/import", { cookie: admin, body: { csv } });
    expect(done.json).toEqual({ ok: true, dryRun: false, count: 3 });
    expect(t.db.prepare("SELECT start, end, break_min AS b FROM schedules WHERE emp_id = 'e01' AND date = '2026-10-12'").get()).toEqual({ start: 1320, end: 1860, b: 60 });

    const bad = await t.call("POST", "/api/schedules/import", {
      cookie: admin,
      body: { csv: ["社員ID,日付,区分,開始,終了,休憩（分）", "e01,2026-10-20,勤務,9:00,,0", "e01,2026-10-20x,休み,,,", "e01,2026-10-21,そうじゃない,,,", "e01,2026-10-22,勤務,18:00,9:00,0", "e01,2026-10-23,休み,,,", "e01,2026-10-23,休み,,,"].join("\n") },
    });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4, 5, 7]);
    expect((await t.call("POST", "/api/schedules/import", { cookie: admin, body: { csv: "a,b\n1,2" } })).json.ok).toBe(false);
    // 形式に誤りがなければ、在籍しない社員・範囲外の日付も確認される
    const unknown = await t.call("POST", "/api/schedules/import", { cookie: admin, body: { csv: ["社員ID,日付,区分,開始,終了", "zzz,2026-10-20,休み,,", "e01,2026-10-21,休み,,"].join("\n") } });
    expect(unknown.json.ok).toBe(false);
    expect(unknown.json.errors).toHaveLength(1);
    expect(unknown.json.errors[0].message).toContain("zzz");
  });
});

describe("勤務区分と会社設定", () => {
  it("社員の勤務区分を変更でき、勤怠の詳細に変形期間・清算期間の状況が出る。通常の社員には出ない", async () => {
    expect((await t.call("PATCH", "/api/employees/e01", { cookie: admin, body: { workStyle: "flex" } })).status).toBe(200);
    const flex = (await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse;
    expect(flex.emp.workStyle).toBe("flex");
    expect(flex.period).toMatchObject({ style: "flex", start: "2026-10-01", end: "2026-10-31", frameMin: 10628 });
    expect(flex.month.periodOvertimeMin).toBeGreaterThanOrEqual(0);
    const fixed = (await t.call("GET", "/api/attendance/e02?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse;
    expect(fixed.period).toBeUndefined();
    const list = (await t.call("GET", "/api/employees", { cookie: admin })).json as EmployeesResponse;
    expect(list.rows.find((r) => r.id === "e01")!.workStyle).toBe("flex");
    expect((await t.call("PATCH", "/api/employees/e01", { cookie: admin, body: { workStyle: "unknown" } })).status).toBe(400);
  });

  it("勤務区分を変えると、同じ打刻でも時間外の集計が変わる（フレックスは、総枠に届かなければ時間外なし）", async () => {
    const before = ((await t.call("GET", "/api/attendance/e03?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse).month.overtimeMin;
    expect(before).toBeGreaterThan(0);
    await t.call("PATCH", "/api/employees/e03", { cookie: admin, body: { workStyle: "flex" } });
    const after = ((await t.call("GET", "/api/attendance/e03?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse).month.overtimeMin;
    expect(after).toBe(0); // 10月はまだ4日分で、総枠（177時間）には届かない
  });

  it("新しい社員を勤務区分つきで登録できる。CSVでは「勤務区分」の列で指定できる", async () => {
    await t.call("POST", "/api/employees", {
      cookie: admin,
      body: { id: "n01", name: "新人", dept: "営業部", kind: "正社員", workDays: [1, 2, 3, 4, 5], baseMin: 480, schedStart: 540, hired: "2026-10-01", workStyle: "yearly" },
    });
    expect(t.db.prepare("SELECT work_style AS s FROM employees WHERE id = 'n01'").get()).toEqual({ s: "yearly" });
    const csv = ["社員ID,氏名,部署,入社日,勤務区分", "n02,甲,営業部,2026-10-01,フレックス", "n03,乙,営業部,2026-10-01,1か月変形", "n04,丙,営業部,2026-10-01,"].join("\n");
    expect((await t.call("POST", "/api/employees/import", { cookie: admin, body: { csv } })).json.ok).toBe(true);
    expect(t.db.prepare("SELECT id, work_style AS s FROM employees WHERE id IN ('n02','n03','n04') ORDER BY id").all()).toEqual([
      { id: "n02", s: "flex" },
      { id: "n03", s: "monthly" },
      { id: "n04", s: "fixed" },
    ]);
    const bad = await t.call("POST", "/api/employees/import", { cookie: admin, body: { csv: ["社員ID,氏名,部署,入社日,勤務区分", "n05,丁,営業部,2026-10-01,謎の制度"].join("\n") } });
    expect(bad.json.ok).toBe(false);
  });

  it("会社設定: 法定休日の曜日・週44時間・清算期間・コアタイム・1年単位の起点月を保存できる。不正な値は拒否される", async () => {
    const patch = (body: unknown) => t.call("PATCH", "/api/settings", { cookie: admin, body });
    const r = await patch({ legalHolidayDow: 6, week44: true, flexMonths: 3, flexStartMonth: 1, yearlyStartMonth: 10, flexCore: { start: 600, end: 900 } });
    expect(r.status).toBe(200);
    const s = (await t.call("GET", "/api/settings", { cookie: admin })).json as SettingsResponse;
    expect(s).toMatchObject({ legalHolidayDow: 6, week44: true, flexMonths: 3, flexStartMonth: 1, yearlyStartMonth: 10, flexCoreStart: 600, flexCoreEnd: 900 });
    await patch({ flexCore: null });
    const cleared = (await t.call("GET", "/api/settings", { cookie: admin })).json as SettingsResponse;
    expect(cleared.flexCoreStart).toBeUndefined();
    expect((await patch({ flexMonths: 4 })).status).toBe(400);
    expect((await patch({ legalHolidayDow: 7 })).status).toBe(400);
    expect((await patch({ flexCore: { start: 900, end: 600 } })).status).toBe(400);
  });

  it("法定休日を土曜にすると、土曜の勤務が休日労働として集計される（会社設定が集計に反映される）", async () => {
    t.db.prepare("DELETE FROM punch_events WHERE emp_id = 'e01' AND date IN ('2026-10-03','2026-10-04')").run();
    const ins = t.db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e01', '2026-10-03', ?, ?, 1)");
    ins.run("in", 600);
    ins.run("out", 840);
    const hol = async () => ((await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse).month.holidayMin;
    const before = await hol();
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { legalHolidayDow: 6 } });
    expect((await hol()) - before).toBe(240);
  });

  it("書き出しデータにシフトと勤務区分が含まれる", async () => {
    await post(admin, [work("e01", "2026-10-12")]);
    const out = (await t.call("GET", "/api/export", { cookie: admin })).json;
    expect(out.schedules).toHaveLength(1);
    expect(out.employees.find((e: { id: string }) => e.id === "e01").workStyle).toBe("fixed");
  });
});

describe("端数処理（月合計の30分丸め）", () => {
  it("設定を有効にすると、時間外・深夜・法定休日の月合計だけが30分単位で丸められる。無効なら実時間のまま", async () => {
    t.db.prepare("DELETE FROM punch_events WHERE emp_id = 'e01'").run();
    const ins = t.db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e01', ?, ?, ?, 1)");
    // 10/1(木) 9:00-18:29（実働9時間29分 → 時間外 1時間29分）
    ins.run("2026-10-01", "in", 540);
    ins.run("2026-10-01", "out", 1109);
    const get = async () => ((await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse).month;
    expect((await get()).overtimeMin).toBe(89);
    expect((await get()).rounded).toBeUndefined();
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { rounding: "month30" } });
    const m = await get();
    expect(m.overtimeMin).toBe(60); // 1時間29分 → 29分は切り捨て
    expect(m.rounded).toBe(true);
    expect(m.workMin).toBe(569); // 総労働時間は丸めない
    // 30分以上は切り上げ
    t.db.prepare("UPDATE punch_events SET min = 1110 WHERE emp_id = 'e01' AND kind = 'out'").run();
    expect((await get()).overtimeMin).toBe(120); // 1時間30分 → 2時間
    // 36協定のチェックは、丸めずに実際の時間で行う
    const risk = ((await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse).risk;
    expect(risk.outlook.mtdOvertime).toBe(90);
  });
});

describe("締め日", () => {
  it("締め日を設定すると、月の期間・現在の月・勤怠の集計が締め日で区切られる。不正な値は拒否される", async () => {
    expect((await t.call("PATCH", "/api/settings", { cookie: admin, body: { closingDay: 29 } })).status).toBe(400);
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { closingDay: 20 } });
    const me = (await t.call("GET", "/api/me", { cookie: admin })).json;
    expect(me.settings.closingDay).toBe(20);
    expect(me.currentYm).toBe("2026-10"); // 10/6 は 9/21〜10/20 の期間（10月分）
    const d = (await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse;
    expect(d.range).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    expect(d.currentYm).toBe("2026-10");
    expect(d.days[0]!.plan.date).toBe("2026-09-21");
    const list = (await t.call("GET", "/api/attendance?ym=2026-10", { cookie: admin })).json;
    expect(list.range).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    // 月末締めに戻すと暦月
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { closingDay: 0 } });
    expect(((await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse).range).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});

describe("給与用CSV", () => {
  const get = async (cookie: string, q: string) => {
    const res = await t.app.request(`/api/attendance/export?${q}`, { headers: { cookie } });
    // Response.text() は先頭の BOM を取り除くので、バイト列から BOM を残したまま読む
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(await res.arrayBuffer()));
    return { status: res.status, text, headers: res.headers };
  };

  it("社員ごとの月次集計。時:分と小数の時間を選べ、見出しとBOMが付く。管理者だけが取得できる", async () => {
    const r = await get(admin, "ym=2026-10&kind=summary&time=hm");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toContain("attendance-summary-2026-10.csv");
    expect(r.headers.get("content-disposition")).toContain(encodeURIComponent("勤怠集計_2026-10.csv"));
    expect(r.text.startsWith("﻿社員ID,氏名,部署")).toBe(true);
    const lines = r.text.split("\r\n");
    expect(lines.length).toBe(1 + 18); // 見出し + 在籍18名
    const e01 = lines.find((l) => l.startsWith("e01,"))!;
    const c = e01.split(",");
    expect(c[1]).toBe("佐藤 健太");
    expect(c[10]).toMatch(/^\d+:\d\d$/); // 総労働時間
    const dec = (await get(admin, "ym=2026-10&kind=summary&time=decimal")).text.split("\r\n").find((l) => l.startsWith("e01,"))!.split(",");
    expect(dec[10]).toMatch(/^\d+\.\d\d$/);
    const [h, m] = c[10]!.split(":").map(Number) as [number, number];
    expect(Number(dec[10])).toBeCloseTo(h + m / 60, 1);
    const emp = await t.login("e01");
    expect((await get(emp, "ym=2026-10&kind=summary")).status).toBe(403);
    expect((await get("", "ym=2026-10")).status).toBe(401);
    expect((await get(admin, "ym=2019-01")).status).toBe(400);
  });

  it("日別の明細。夜勤の退勤は25:00のような時刻で、氏名の先頭が数式の文字でも無害化される", async () => {
    t.db.prepare("UPDATE employees SET name = '=1+1' WHERE id = 'e02'").run();
    t.db.prepare("DELETE FROM punch_events WHERE emp_id = 'e01'").run();
    const ins = t.db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e01', '2026-10-01', ?, ?, 1)");
    ins.run("in", 1320);
    ins.run("out", 1500);
    const r = await get(admin, "ym=2026-10&kind=detail&time=hm");
    const lines = r.text.split("\r\n");
    expect(lines[0]).toContain("社員ID,氏名,日付,曜日,区分,出勤,退勤");
    expect(lines.find((l) => l.startsWith("e01,佐藤 健太,2026-10-01,木,出勤,22:00,25:00"))).toBeTruthy();
    expect(lines.some((l) => l.startsWith("e02,'=1+1,"))).toBe(true);
    expect(lines.some((l) => l.startsWith("e02,=1+1"))).toBe(false);
  });
});
