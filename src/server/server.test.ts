import { beforeEach, describe, expect, it } from "vitest";
import type { AttendanceDetailResponse, AttendanceListResponse, DashboardResponse, LeaveResponse, MeResponse, PunchStateResponse, RequestView } from "../domain";
import { PASSWORD, setup, TODAY } from "./testkit";

describe("認証", () => {
  const t = setup({ nowMin: 14 * 60 + 20, at: "14:20" });

  it("未ログインは 401", async () => {
    expect((await t.call("GET", "/api/me")).status).toBe(401);
    expect((await t.call("GET", "/api/dashboard")).status).toBe(401);
  });

  it("ログイン成功で HttpOnly の Cookie が付き、自分の情報を取得できる", async () => {
    const r = await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e01", password: PASSWORD } });
    const cookie = r.res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const me = (await t.call("GET", "/api/me", { cookie: cookie.split(";")[0] })).json as MeResponse;
    expect(me.employee.name).toBe("佐藤 健太");
    expect(me.employee.role).toBe("employee");
    expect(me.pending).toBe(0);
  });

  it("パスワードの値は DB に平文で保存されない", () => {
    const rows = t.db.prepare("SELECT password_hash FROM employees").all() as { password_hash: string }[];
    expect(rows.every((r) => r.password_hash.startsWith("scrypt$") && !r.password_hash.includes(PASSWORD))).toBe(true);
  });

  it("ログアウト後は同じ Cookie が使えない", async () => {
    const cookie = await t.login("e01");
    await t.call("POST", "/api/auth/logout", { cookie });
    expect((await t.call("GET", "/api/me", { cookie })).status).toBe(401);
  });

  it("誤ったパスワードと存在しない社員IDで同じメッセージを返す", async () => {
    const a = await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e02", password: "wrong-password" } });
    const b = await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "nobody", password: "wrong-password" } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json.error).toBe(b.json.error);
  });

  it("5回続けて失敗するとロックされ、正しいパスワードでも入れない", async () => {
    for (let i = 0; i < 5; i++) await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e09", password: "wrong-password" } });
    const r = await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e09", password: PASSWORD } });
    expect(r.status).toBe(423);
  });

  it("別オリジンからの更新系リクエストは拒否する", async () => {
    const r = await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e01", password: PASSWORD }, headers: { origin: "https://evil.example", host: "localhost" } });
    expect(r.status).toBe(403);
  });
});

describe("パスワード変更", () => {
  const t = setup({ nowMin: 14 * 60 + 20, at: "14:20" });

  it("変更すると古いパスワード・他端末のセッションは無効になり、新しいパスワードで入れる", async () => {
    const a = await t.login("e11");
    const other = await t.login("e11");
    const r = await t.call("POST", "/api/auth/password", { cookie: a, body: { current: PASSWORD, next: "new-password-99" } });
    expect(r.status).toBe(200);
    const fresh = r.res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await t.call("GET", "/api/me", { cookie: other })).status).toBe(401);
    expect((await t.call("GET", "/api/me", { cookie: a })).status).toBe(401);
    expect((await t.call("GET", "/api/me", { cookie: fresh })).status).toBe(200);
    expect((await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e11", password: PASSWORD } })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e11", password: "new-password-99" } })).status).toBe(200);
  });

  it("現在のパスワードが違う・短すぎる・同じ場合は拒否する", async () => {
    const c = await t.login("e12");
    expect((await t.call("POST", "/api/auth/password", { cookie: c, body: { current: "wrong-password", next: "new-password-99" } })).status).toBe(400);
    expect((await t.call("POST", "/api/auth/password", { cookie: c, body: { current: PASSWORD, next: "short" } })).status).toBe(400);
    expect((await t.call("POST", "/api/auth/password", { cookie: c, body: { current: PASSWORD, next: PASSWORD } })).status).toBe(400);
  });

  it("未ログインでは変更できない", async () => {
    expect((await t.call("POST", "/api/auth/password", { body: { current: PASSWORD, next: "new-password-99" } })).status).toBe(401);
  });
});

describe("権限", () => {
  const t = setup({ nowMin: 14 * 60 + 20, at: "14:20" });

  it("一般社員は管理者用の API を使えない", async () => {
    const c = await t.login("e01");
    for (const p of ["/api/dashboard", "/api/attendance?ym=2026-09"]) expect((await t.call("GET", p, { cookie: c })).status).toBe(403);
    expect((await t.call("GET", "/api/attendance/e02?ym=2026-09", { cookie: c })).status).toBe(403);
    expect((await t.call("POST", "/api/requests/1/decision", { cookie: c, body: { decision: "approved" } })).status).toBe(403);
  });

  it("一般社員は自分の勤怠・有給・申請だけ見られる", async () => {
    const c = await t.login("e01");
    expect((await t.call("GET", "/api/attendance/e01?ym=2026-09", { cookie: c })).status).toBe(200);
    const leave = (await t.call("GET", "/api/leave", { cookie: c })).json as LeaveResponse;
    expect(leave.rows.map((r) => r.emp.id)).toEqual(["e01"]);
    const reqs = (await t.call("GET", "/api/requests", { cookie: c })).json as RequestView[];
    expect(reqs.every((r) => r.emp.id === "e01")).toBe(true);
  });

  it("管理者は全員分を見られる", async () => {
    const c = await t.login("e16");
    const list = (await t.call("GET", "/api/attendance?ym=2026-09", { cookie: c })).json as AttendanceListResponse;
    expect(list.rows).toHaveLength(18);
    const dash = (await t.call("GET", "/api/dashboard", { cookie: c })).json as DashboardResponse;
    expect(dash.rows).toHaveLength(18);
    expect(dash.pending.length).toBeGreaterThan(0);
  });
});

describe("集計", () => {
  const t = setup({ nowMin: 14 * 60 + 20, at: "14:20" });

  it("一覧と個人明細の数字が一致し、日別の時間外の合計は月の時間外以下になる", async () => {
    const c = await t.login("e16");
    const list = (await t.call("GET", "/api/attendance?ym=2026-09", { cookie: c })).json as AttendanceListResponse;
    const row = list.rows.find((r) => r.emp.id === "e06")!;
    const d = (await t.call("GET", "/api/attendance/e06?ym=2026-09", { cookie: c })).json as AttendanceDetailResponse;
    expect(d.month.overtimeMin).toBe(row.month.overtimeMin);
    const daily = d.days.reduce((s, x) => s + (x.result?.dailyOvertimeMin ?? 0), 0);
    expect(d.month.overtimeMin - daily).toBe(d.month.weeklyOvertimeMin);
    expect(row.month.overtimeMin).toBeGreaterThan(45 * 60);
  });

  it("長時間残業が続く社員は 36協定の監視リストに載る", async () => {
    const c = await t.login("e16");
    const dash = (await t.call("GET", "/api/dashboard", { cookie: c })).json as DashboardResponse;
    const e06 = dash.watch.find((w) => w.emp.id === "e06");
    expect(e06?.risk.level).toBe("violation");
    expect(dash.violating).toBeGreaterThanOrEqual(1);
    expect(dash.watch.every((w, i, a) => i === 0 || a[i - 1]!.risk.outlook.projOvertime >= w.risk.outlook.projOvertime)).toBe(true);
  });

  it("本日の勤務状況: 休暇・勤務中・休みが区別される", async () => {
    const c = await t.login("e16");
    const dash = (await t.call("GET", "/api/dashboard", { cookie: c })).json as DashboardResponse;
    const st = Object.fromEntries(dash.rows.map((r) => [r.emp.id, r.status]));
    expect(st.e04).toBe("leave");
    expect(st.e06).toBe("working");
    expect(st.e14).toBe("off"); // 林さんは水・金・月のみ出勤（火曜は所定休日）
  });

  it("対象月が協定期間外・不正なら 400", async () => {
    const c = await t.login("e16");
    expect((await t.call("GET", "/api/attendance?ym=2025-01", { cookie: c })).status).toBe(400);
    expect((await t.call("GET", "/api/attendance?ym=abc", { cookie: c })).status).toBe(400);
  });
});

describe("打刻", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup({ nowMin: -1, at: "09:00" }); // 本日の打刻なし
  });

  it("出勤→休憩→退勤が記録され、サーバー時刻が使われる", async () => {
    const c = await t.login("e01");
    let s = (await t.call("POST", "/api/punch", { cookie: c, body: { action: "in", min: 1 } })).json as PunchStateResponse;
    expect(s.events.in).toBe(540); // クライアントが送った min は無視される
    t.clock.set(TODAY, "12:00");
    s = (await t.call("POST", "/api/punch", { cookie: c, body: { action: "break_start" } })).json as PunchStateResponse;
    expect(s.events.openBreak).toBe(720);
    t.clock.set(TODAY, "13:00");
    s = (await t.call("POST", "/api/punch", { cookie: c, body: { action: "break_end" } })).json as PunchStateResponse;
    expect(s.events.breaks).toEqual([{ start: 720, end: 780 }]);
    t.clock.set(TODAY, "18:30");
    s = (await t.call("POST", "/api/punch", { cookie: c, body: { action: "out" } })).json as PunchStateResponse;
    expect(s.events.out).toBe(1110);
    expect(s.day.workMin).toBe(8 * 60 + 30);
    expect(s.day.dailyOvertimeMin).toBe(30);
  });

  it("順序の誤りは 409 で拒否される", async () => {
    const c = await t.login("e01");
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "out" } })).status).toBe(409);
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "break_start" } })).status).toBe(409);
    await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } });
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } })).status).toBe(409);
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "break_end" } })).status).toBe(409);
    await t.call("POST", "/api/punch", { cookie: c, body: { action: "out" } });
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "out" } })).status).toBe(409);
  });

  it("休憩中に退勤すると休憩が退勤時刻で閉じる", async () => {
    const c = await t.login("e01");
    await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } });
    t.clock.set(TODAY, "17:00");
    await t.call("POST", "/api/punch", { cookie: c, body: { action: "break_start" } });
    t.clock.set(TODAY, "17:30");
    const s = (await t.call("POST", "/api/punch", { cookie: c, body: { action: "out" } })).json as PunchStateResponse;
    expect(s.events.breaks).toEqual([{ start: 1020, end: 1050 }]);
    expect(s.events.openBreak).toBeUndefined();
  });

  it("不正な action は 400", async () => {
    const c = await t.login("e01");
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "teleport" } })).status).toBe(400);
  });

  it("打刻は監査ログに残る", async () => {
    const c = await t.login("e01");
    await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } });
    const n = (t.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'e01' AND action = 'punch'").get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe("申請と承認", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup({ nowMin: 14 * 60 + 20, at: "14:20" });
  });

  const pendingOf = async (cookie: string, empId: string, kind: string) =>
    ((await t.call("GET", "/api/requests?status=pending", { cookie })).json as RequestView[]).find((r) => r.emp.id === empId && r.kind === kind)!;

  it("有給申請を承認すると取得予定として登録され、残日数の計算に反映される", async () => {
    const admin = await t.login("e16");
    const emp = await t.login("e03");
    const before = ((await t.call("GET", "/api/leave", { cookie: emp })).json as LeaveResponse).rows[0]!;
    const r = await t.call("POST", "/api/requests", { cookie: emp, body: { kind: "有給申請", date: "2026-10-20", days: 0.5, reason: "私用" } });
    expect(r.status).toBe(201);
    const decide = await t.call("POST", `/api/requests/${r.json.id}/decision`, { cookie: admin, body: { decision: "approved" } });
    expect(decide.status).toBe(200);
    const after = ((await t.call("GET", "/api/leave", { cookie: emp })).json as LeaveResponse).rows[0]!;
    expect(after.planned).toBe(before.planned + 0.5);
    // 処理済みの申請は再処理できない
    expect((await t.call("POST", `/api/requests/${r.json.id}/decision`, { cookie: admin, body: { decision: "rejected" } })).status).toBe(409);
  });

  it("却下した有給申請は残日数に影響しない", async () => {
    const admin = await t.login("e16");
    const emp = await t.login("e03");
    const before = ((await t.call("GET", "/api/leave", { cookie: emp })).json as LeaveResponse).rows[0]!;
    const r = await t.call("POST", "/api/requests", { cookie: emp, body: { kind: "有給申請", date: "2026-10-21", days: 1, reason: "私用" } });
    await t.call("POST", `/api/requests/${r.json.id}/decision`, { cookie: admin, body: { decision: "rejected" } });
    const after = ((await t.call("GET", "/api/leave", { cookie: emp })).json as LeaveResponse).rows[0]!;
    expect(after.planned).toBe(before.planned);
    expect(after.remaining).toBe(before.remaining);
  });

  it("打刻修正を承認すると勤怠に反映され、元の打刻も追記のまま残る", async () => {
    const admin = await t.login("e16");
    const q = await pendingOf(admin, "e12", "打刻修正");
    expect(q.detail).toContain("→ 19:15");
    const rowsBefore = (t.db.prepare("SELECT COUNT(*) AS n FROM punch_events WHERE emp_id = 'e12' AND date = ?").get(q.date) as { n: number }).n;
    expect((await t.call("POST", `/api/requests/${q.id}/decision`, { cookie: admin, body: { decision: "approved" } })).status).toBe(200);
    const rowsAfter = (t.db.prepare("SELECT COUNT(*) AS n FROM punch_events WHERE emp_id = 'e12' AND date = ?").get(q.date) as { n: number }).n;
    expect(rowsAfter).toBe(rowsBefore + 1);
    const d = (await t.call("GET", "/api/attendance/e12?ym=2026-10", { cookie: admin })).json as AttendanceDetailResponse;
    expect(d.days.find((x) => x.plan.date === q.date)?.plan.end).toBe(1155);
  });

  it("一般社員は承認できず、管理者が複数いる会社では自分の申請を承認できない", async () => {
    t.db.exec("UPDATE employees SET role = 'admin' WHERE id = 'e02'"); // 管理者を2人にする
    const admin = await t.login("e16");
    const emp = await t.login("e03");
    const mine = await t.call("POST", "/api/requests", { cookie: admin, body: { kind: "有給申請", date: "2026-10-22", days: 1, reason: "私用" } });
    expect(mine.status).toBe(201);
    expect((await t.call("POST", `/api/requests/${mine.json.id}/decision`, { cookie: admin, body: { decision: "approved" } })).status).toBe(403);
    expect((await t.call("POST", `/api/requests/${mine.json.id}/decision`, { cookie: emp, body: { decision: "approved" } })).status).toBe(403);
    // 別の管理者なら承認できる
    const other = await t.login("e02");
    expect((await t.call("POST", `/api/requests/${mine.json.id}/decision`, { cookie: other, body: { decision: "approved" } })).status).toBe(200);
  });

  it("管理者が1人だけの会社では自分の申請を処理でき、監査ログに残る", async () => {
    const admin = await t.login("e16");
    const mine = await t.call("POST", "/api/requests", { cookie: admin, body: { kind: "有給申請", date: "2026-10-22", days: 1, reason: "私用" } });
    expect((await t.call("POST", `/api/requests/${mine.json.id}/decision`, { cookie: admin, body: { decision: "approved" } })).status).toBe(200);
    const log = t.db.prepare("SELECT detail FROM audit_log WHERE action = 'request_approved' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(log.detail).selfApproved).toBe(true);
  });

  it("申請者は未処理の申請を取り下げられる（他人の申請は不可）", async () => {
    const emp = await t.login("e03");
    const other = await t.login("e01");
    const r = await t.call("POST", "/api/requests", { cookie: emp, body: { kind: "有給申請", date: "2026-10-23", days: 1, reason: "私用" } });
    expect((await t.call("DELETE", `/api/requests/${r.json.id}`, { cookie: other })).status).toBe(404);
    expect((await t.call("DELETE", `/api/requests/${r.json.id}`, { cookie: emp })).status).toBe(200);
  });

  it("入力の検証: 休日の有給・平日の休日出勤・理由なし・未来の打刻修正は拒否", async () => {
    const emp = await t.login("e03");
    const post = (body: unknown) => t.call("POST", "/api/requests", { cookie: emp, body });
    expect((await post({ kind: "有給申請", date: "2026-10-11", days: 1, reason: "私用" })).status).toBe(400); // 日曜
    expect((await post({ kind: "有給申請", date: "2026-10-12", days: 1, reason: "私用" })).status).toBe(400); // スポーツの日
    expect((await post({ kind: "休日出勤", date: "2026-10-07", start: 600, end: 900, reason: "作業" })).status).toBe(400); // 水曜
    expect((await post({ kind: "残業申請", date: "2026-10-07", start: 1080, end: 1020, reason: "作業" })).status).toBe(400);
    expect((await post({ kind: "残業申請", date: "2026-10-07", start: 1080, end: 1200, reason: "  " })).status).toBe(400);
    expect((await post({ kind: "打刻修正", date: "2026-10-07", in: 540, reason: "忘れ" })).status).toBe(400); // 未来
    expect((await post({ kind: "打刻修正", date: "2026-10-05", reason: "忘れ" })).status).toBe(400); // 内容なし
    expect((await post({ kind: "打刻修正", date: "2026-10-04", out: 1100, reason: "忘れ" })).status).toBe(400); // 日曜で出勤の打刻がない
    expect((await post({ kind: "有給申請", date: "2026-10-20", days: 3, reason: "私用" })).status).toBe(400);
  });

  it("同じ日の有給を二重に申請できない", async () => {
    const emp = await t.login("e03");
    const body = { kind: "有給申請", date: "2026-10-26", days: 1, reason: "私用" };
    expect((await t.call("POST", "/api/requests", { cookie: emp, body })).status).toBe(201);
    expect((await t.call("POST", "/api/requests", { cookie: emp, body })).status).toBe(409);
  });

  it("有給の残日数を超える申請は 409", async () => {
    const emp = await t.login("e10"); // 付与10日・取得0
    const db = t.db;
    db.prepare("INSERT INTO paid_leave (emp_id, date, days) VALUES ('e10', '2026-10-27', 1)").run();
    db.exec("UPDATE employees SET carry = 0 WHERE id = 'e10'");
    // 付与10日から、取得済み・予定を使い切るまで登録して残り0にする
    const info = ((await t.call("GET", "/api/leave", { cookie: emp })).json as LeaveResponse).rows[0]!;
    const left = info.granted - info.taken - info.planned;
    for (let i = 0; i < left; i++) db.prepare("INSERT INTO paid_leave (emp_id, date, days) VALUES ('e10', ?, 1)").run(`2027-02-${String(1 + i).padStart(2, "0")}`);
    const r = await t.call("POST", "/api/requests", { cookie: emp, body: { kind: "有給申請", date: "2026-11-02", days: 1, reason: "私用" } });
    expect(r.status).toBe(409);
  });
});
