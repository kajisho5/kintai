import { beforeEach, describe, expect, it } from "vitest";
import type { AttendanceDetailResponse, DashboardResponse, PunchStateResponse } from "../domain";
import { setup, TODAY } from "./testkit";

const NEXT = "2026-10-07";
const act = (t: ReturnType<typeof setup>, cookie: string, action: string) => t.call("POST", "/api/punch", { cookie, body: { action } });
const events = (t: ReturnType<typeof setup>, id: string, date: string) =>
  t.db.prepare("SELECT kind, min FROM punch_events WHERE emp_id = ? AND date = ? ORDER BY seq").all(id, date) as { kind: string; min: number }[];

describe("日またぎ（夜勤）の打刻", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup({ nowMin: -1, at: "22:00" }); // 火曜の夜。本日の打刻なし
  });

  it("夜に出勤し、翌日の朝に退勤すると、1つの勤務（始業日の打刻・25:00のような時刻）として記録される", async () => {
    const c = await t.login("e01");
    expect((await act(t, c, "in")).status).toBe(200);
    t.clock.set(NEXT, "02:00");
    const brk = (await act(t, c, "break_start")).json as PunchStateResponse;
    expect(brk.date).toBe(TODAY); // 始業日の勤務として扱う
    expect(brk.offsetMin).toBe(1440);
    expect(brk.nowMin).toBe(1560);
    expect(brk.events.openBreak).toBe(1560);
    t.clock.set(NEXT, "03:00");
    await act(t, c, "break_end");
    t.clock.set(NEXT, "07:00");
    const out = (await act(t, c, "out")).json as PunchStateResponse;
    expect(out.events).toEqual({ in: 1320, out: 1860, breaks: [{ start: 1560, end: 1620 }], openBreak: undefined });
    expect(out.day.workMin).toBe(8 * 60);
    expect(out.day.dailyOvertimeMin).toBe(0);
    expect(out.day.nightMin).toBe(6 * 60);
    expect(events(t, "e01", TODAY).map((e) => e.kind)).toEqual(["in", "break_start", "break_end", "out"]);
    expect(events(t, "e01", NEXT)).toEqual([]); // 翌日の打刻としては残らない
  });

  it("退勤したあと朝のうちは、その勤務が「退勤済み」として表示される。夜に次の勤務を開始できる", async () => {
    let c = await t.login("e01");
    await act(t, c, "in");
    t.clock.set(NEXT, "07:00");
    await act(t, c, "out");
    t.clock.set(NEXT, "08:30");
    const s = (await t.call("GET", "/api/punch/today", { cookie: c })).json as PunchStateResponse;
    expect(s.date).toBe(TODAY);
    expect(s.events.out).toBe(1860);
    expect((await act(t, c, "out")).status).toBe(409); // 二重の退勤は拒否

    t.clock.set(NEXT, "22:00");
    c = await t.login("e01"); // セッションは12時間で切れる
    const next = (await act(t, c, "in")).json as PunchStateResponse;
    expect(next.date).toBe(NEXT);
    expect(next.offsetMin).toBe(0);
    expect(next.events.in).toBe(1320);
  });

  it("日またぎで勤務中に「出勤」を押しても二重にならない", async () => {
    const c = await t.login("e01");
    await act(t, c, "in");
    t.clock.set(NEXT, "00:05");
    const r = await act(t, c, "in");
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("退勤");
    expect(events(t, "e01", NEXT)).toEqual([]);
  });

  it("退勤の打刻漏れ（20時間を超える）は日またぎの勤務とはみなさず、新しい勤務として出勤できる", async () => {
    let c = await t.login("e01");
    await act(t, c, "in"); // 火曜 22:00
    t.clock.set(NEXT, "20:00"); // 22時間後
    c = await t.login("e01");
    expect((await act(t, c, "out")).status).toBe(409); // 昨日の勤務への退勤とはしない
    expect((await act(t, c, "in")).status).toBe(200);
    expect(events(t, "e01", TODAY).map((e) => e.kind)).toEqual(["in"]); // 火曜の退勤は未打刻のまま（修正申請の対象）
    expect(events(t, "e01", NEXT).map((e) => e.kind)).toEqual(["in"]);
  });

  it("管理者のダッシュボードでは、日またぎの勤務中の社員が「勤務中」、退勤後は「退勤済」で、帯は今日の0:00より前から始まる", async () => {
    const c = await t.login("e01");
    const admin = await t.login("e16");
    await act(t, c, "in");
    t.clock.set(NEXT, "02:00");
    let d = (await t.call("GET", "/api/dashboard", { cookie: admin })).json as DashboardResponse;
    let row = d.rows.find((r) => r.emp.id === "e01")!;
    expect(row.status).toBe("working");
    expect(row.start).toBe(-120); // 前日22:00 = 今日の0:00の2時間前
    expect(row.bars[0]!.from).toBe(-120);
    expect(row.note).toBe("日またぎ");

    t.clock.set(NEXT, "07:00");
    await act(t, c, "out");
    t.clock.set(NEXT, "08:00");
    d = (await t.call("GET", "/api/dashboard", { cookie: admin })).json as DashboardResponse;
    row = d.rows.find((r) => r.emp.id === "e01")!;
    expect(row.status).toBe("left");
    expect(row.end).toBe(420);
    expect(row.workedMin).toBe(9 * 60);
  });

  it("勤怠一覧には始業日の勤務として、深夜と時間外が集計される", async () => {
    const c = await t.login("e01");
    await act(t, c, "in");
    t.clock.set(NEXT, "07:00"); // 休憩なし 9時間
    await act(t, c, "out");
    t.clock.set(NEXT, "09:00");
    const detail = (await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: c })).json as AttendanceDetailResponse;
    const row = detail.days.find((r) => r.plan.date === TODAY)!;
    expect(row.plan.kind).toBe("work");
    expect(row.plan.end).toBe(1860);
    expect(row.result!.workMin).toBe(9 * 60);
    expect(row.result!.dailyOvertimeMin).toBe(60);
    expect(row.result!.nightMin).toBe(7 * 60);
  });

  it("まだ退勤していない日またぎの勤務は、勤務中として扱われ、打刻漏れとは表示されない", async () => {
    const c = await t.login("e01");
    await act(t, c, "in");
    t.clock.set(NEXT, "03:00");
    const detail = (await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: c })).json as AttendanceDetailResponse;
    const row = detail.days.find((r) => r.plan.date === TODAY)!;
    expect(row.plan.kind).toBe("incomplete");
    expect(row.plan.note).toBe("勤務中（日またぎ）");
  });
});

describe("日またぎと法定休日", () => {
  it("土曜の夜から日曜の朝（22:00→7:00）は、日曜0:00以降の7時間が休日労働として集計される", async () => {
    const t = setup({ nowMin: -1, at: "09:00" });
    const c = await t.login("e01");
    t.db.prepare("DELETE FROM punch_events WHERE emp_id = 'e01' AND date IN ('2026-10-03', '2026-10-04')").run();
    const ins = t.db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, created_at) VALUES ('e01', '2026-10-03', ?, ?, 1)");
    ins.run("in", 22 * 60);
    ins.run("out", 31 * 60);
    const detail = (await t.call("GET", "/api/attendance/e01?ym=2026-10", { cookie: c })).json as AttendanceDetailResponse;
    const r = detail.days.find((x) => x.plan.date === "2026-10-03")!.result!;
    expect(r.workMin).toBe(9 * 60);
    expect(r.legalHolidayMin).toBe(7 * 60);
    expect(r.legalInMin).toBe(2 * 60);
    expect(r.dailyOvertimeMin).toBe(0);
  });
});
