import { describe, expect, it } from "vitest";
import type { AttendanceListResponse, DashboardResponse, EmployeesResponse, ImportResponse, MeResponse, SettingsResponse } from "../domain";
import { CSV_HEADERS, parseEmployeeCsv } from "./routes/admin";
import { PASSWORD, setup } from "./testkit";

const NEW = { id: "n01", name: "新入 花子", dept: "営業部", title: "", kind: "正社員", role: "employee", workDays: [1, 2, 3, 4, 5], baseMin: 480, schedStart: 540, hired: "2026-10-01", carry: 0 };

describe("社員管理", () => {
  it("管理者だけが一覧を見られる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await t.call("GET", "/api/employees", { cookie: await t.login("e01") })).status).toBe(403);
    const r = (await t.call("GET", "/api/employees", { cookie: await t.login("e16") })).json as EmployeesResponse;
    expect(r.rows).toHaveLength(18);
    expect(r.seatsUsed).toBe(18);
  });

  it("追加すると一時パスワードが発行され、初回ログイン後はパスワード変更が終わるまで他の操作ができない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const r = await t.call("POST", "/api/employees", { cookie: admin, body: NEW });
    expect(r.status).toBe(201);
    const temp = r.json.tempPassword as string;
    expect(temp).toHaveLength(12);

    const cookie = await t.login("n01", temp);
    const me = (await t.call("GET", "/api/me", { cookie })).json as MeResponse;
    expect(me.mustChangePassword).toBe(true);
    const blocked = await t.call("GET", "/api/punch/today", { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const ch = await t.call("POST", "/api/auth/password", { cookie, body: { current: temp, next: "my-new-password-1" } });
    expect(ch.status).toBe(200);
    const fresh = ch.res.headers.get("set-cookie")!.split(";")[0]!;
    expect(((await t.call("GET", "/api/me", { cookie: fresh })).json as MeResponse).mustChangePassword).toBe(false);
    expect((await t.call("GET", "/api/punch/today", { cookie: fresh })).status).toBe(200);
  });

  it("管理者が決めたパスワードで追加しても、初回に本人が変更する", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    await t.call("POST", "/api/employees", { cookie: admin, body: { ...NEW, password: "chosen-by-admin-1" } });
    const cookie = await t.login("n01", "chosen-by-admin-1");
    expect(((await t.call("GET", "/api/me", { cookie })).json as MeResponse).mustChangePassword).toBe(true);
  });

  it("入力の検証と重複", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const post = (body: unknown) => t.call("POST", "/api/employees", { cookie: admin, body });
    expect((await post({ ...NEW, id: "bad id" })).status).toBe(400);
    expect((await post({ ...NEW, workDays: [] })).status).toBe(400);
    expect((await post({ ...NEW, workDays: [9] })).status).toBe(400);
    expect((await post({ ...NEW, hired: "2026-13-40" })).status).toBe(400);
    expect((await post({ ...NEW, email: "x" })).status).toBe(400);
    expect((await post({ ...NEW, carry: 0.3 })).status).toBe(400);
    expect((await post({ ...NEW, baseMin: 5 })).status).toBe(400);
    expect((await post({ ...NEW, id: "e01" })).status).toBe(409);
  });

  it("契約人数の上限を超えて追加できない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: t.clock.now().ts + 86400_000 });
    const admin = await t.login("e16");
    for (let i = 0; i < 12; i++) expect((await t.call("POST", "/api/employees", { cookie: admin, body: { ...NEW, id: `n${i}` } })).status).toBe(201);
    const over = await t.call("POST", "/api/employees", { cookie: admin, body: { ...NEW, id: "over" } });
    expect(over.status).toBe(409);
    expect(over.json.code).toBe("SEAT_LIMIT");
  });

  it("編集: 所定労働日・時間を変えると週あたりの値も更新される。権限変更で本人のセッションは切れる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const target = await t.login("e03");
    expect((await t.call("PATCH", "/api/employees/e03", { cookie: admin, body: { workDays: [1, 3, 5], baseMin: 360, dept: "開発部" } })).status).toBe(200);
    const row = ((await t.call("GET", "/api/employees", { cookie: admin })).json as EmployeesResponse).rows.find((r) => r.id === "e03")!;
    expect(row).toMatchObject({ dept: "開発部", weeklyDays: 3, weeklyHours: 18, baseMin: 360 });
    await t.call("PATCH", "/api/employees/e03", { cookie: admin, body: { role: "admin" } });
    expect((await t.call("GET", "/api/me", { cookie: target })).status).toBe(401);
    expect((await t.call("PATCH", "/api/employees/e03", { cookie: admin, body: {} })).status).toBe(400);
    expect((await t.call("PATCH", "/api/employees/none", { cookie: admin, body: { name: "x" } })).status).toBe(404);
  });

  it("編集しても、指定していない項目（繰越有給など）は変わらない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const get = async () => ((await t.call("GET", "/api/employees", { cookie: admin })).json as EmployeesResponse).rows.find((r) => r.id === "e01")!;
    const before = await get();
    expect(before.carry).toBe(8);
    await t.call("PATCH", "/api/employees/e01", { cookie: admin, body: { dept: "営業企画部" } });
    const after = await get();
    expect(after).toMatchObject({ dept: "営業企画部", carry: 8, name: before.name, hired: before.hired, baseMin: before.baseMin });
  });

  it("最後の管理者の降格・退職は拒否し、自分自身は退職処理できない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    expect((await t.call("PATCH", "/api/employees/e16", { cookie: admin, body: { role: "employee" } })).status).toBe(409);
    expect((await t.call("POST", "/api/employees/e16/deactivate", { cookie: admin })).status).toBe(400);
    // 管理者を2人にすれば、もう1人は退職処理できる
    await t.call("PATCH", "/api/employees/e02", { cookie: admin, body: { role: "admin" } });
    const second = await t.login("e02");
    expect((await t.call("POST", "/api/employees/e16/deactivate", { cookie: second })).status).toBe(200);
    expect((await t.call("POST", "/api/employees/e02/deactivate", { cookie: second })).status).toBe(400); // 自分自身
  });

  it("退職処理: ログイン不可・申請は取り下げ。過去月の勤怠には残り、在籍者一覧からは外れる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const emp = await t.login("e03");
    await t.call("POST", "/api/requests", { cookie: emp, body: { kind: "残業申請", date: "2026-10-07", start: 1080, end: 1200, reason: "作業" } });
    expect((await t.call("POST", "/api/employees/e03/deactivate", { cookie: admin })).status).toBe(200);
    expect((await t.call("GET", "/api/me", { cookie: emp })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e03", password: PASSWORD } })).status).toBe(401);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE emp_id = 'e03' AND status = 'pending'").get()).toEqual({ n: 0 });

    const sep = (await t.call("GET", "/api/attendance?ym=2026-09", { cookie: admin })).json as AttendanceListResponse;
    expect(sep.rows.some((r) => r.emp.id === "e03" && r.month.workDays > 0)).toBe(true);
    const dash = (await t.call("GET", "/api/dashboard", { cookie: admin })).json as DashboardResponse;
    expect(dash.rows.some((r) => r.emp.id === "e03")).toBe(false);
    expect(dash.headcount).toBe(17);
    expect(((await t.call("GET", "/api/me", { cookie: admin })).json as MeResponse).tenant.seatsUsed).toBe(17);

    // 復帰
    expect((await t.call("POST", "/api/employees/e03/reactivate", { cookie: admin })).status).toBe(200);
    expect((await t.call("POST", "/api/employees/e03/reactivate", { cookie: admin })).status).toBe(409);
  });

  it("退職日より後の日は欠勤扱いにならない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    t.db.exec("UPDATE employees SET active = 0, left_on = '2026-09-15' WHERE id = 'e03'");
    const d = (await t.call("GET", "/api/attendance/e03?ym=2026-09", { cookie: admin })).json;
    const after = d.days.filter((x: { plan: { date: string } }) => x.plan.date > "2026-09-15");
    expect(after).toHaveLength(0);
    expect(d.month.absentDays).toBe(0);
  });

  it("パスワード再発行: 古いパスワードとセッションは無効になり、次回ログインで変更が必要になる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const old = await t.login("e04");
    const r = await t.call("POST", "/api/employees/e04/reset-password", { cookie: admin });
    expect(r.status).toBe(200);
    expect((await t.call("GET", "/api/me", { cookie: old })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e04", password: PASSWORD } })).status).toBe(401);
    const c = await t.login("e04", r.json.tempPassword);
    expect(((await t.call("GET", "/api/me", { cookie: c })).json as MeResponse).mustChangePassword).toBe(true);
    expect((await t.call("POST", "/api/employees/e16/reset-password", { cookie: admin })).status).toBe(400);
  });
});

describe("CSV取り込み", () => {
  const header = CSV_HEADERS.join(",");
  const imp = (t: ReturnType<typeof setup>, cookie: string, csv: string, dryRun = false) =>
    t.call("POST", "/api/employees/import", { cookie, body: { csv, dryRun } });

  it("見出し行の不足・不正な値は、行番号つきで報告され、何も登録されない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const bad = (await imp(t, admin, "氏名,部署\nあ,い")).json as ImportResponse;
    expect(bad.ok).toBe(false);
    const csv = [header, "x1,山田,営業,,正社員,一般,,2026/4/1,月火水木金,8,9:00,0", "x2,,営業,,正社員,一般,,2026-04-01,,,,", "e01,重複,営業,,,,,2026-04-01,,,,", "x4,曜日,営業,,,,,2026-04-01,月火あ,,,"].join("\n");
    const r = (await imp(t, admin, csv)).json as ImportResponse;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.row)).toEqual([3, 4, 5]);
      expect(r.errors[1]!.message).toContain("すでに登録");
    }
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM employees").get()).toEqual({ n: 18 });
  });

  it("取り込みに成功すると一時パスワードが返り、本人はそれでログインできる。dryRun では登録しない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const csv = [header, "p01,佐々木 花,カスタマーサポート,,パート,一般,sasaki@example.com,2026-10-01,月水金,5,10:00,2", "p02,中島 太郎,管理部,課長,正社員,管理者,,2026/10/1,,,,"].join("\r\n");
    const dry = (await imp(t, admin, csv, true)).json as ImportResponse;
    expect(dry).toEqual({ ok: true, dryRun: true, count: 2 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM employees").get()).toEqual({ n: 18 });

    const r = (await imp(t, admin, csv)).json as ImportResponse;
    expect(r.ok && !r.dryRun && r.count).toBe(2);
    if (r.ok && !r.dryRun) {
      const cookie = await t.login("p01", r.credentials[0]!.tempPassword);
      expect(((await t.call("GET", "/api/me", { cookie })).json as MeResponse).employee.name).toBe("佐々木 花");
    }
    const rows = ((await t.call("GET", "/api/employees", { cookie: admin })).json as EmployeesResponse).rows;
    expect(rows.find((x) => x.id === "p01")).toMatchObject({ kind: "パート", workDays: [1, 3, 5], baseMin: 300, weeklyDays: 3, weeklyHours: 15, carry: 2, email: "sasaki@example.com" });
    expect(rows.find((x) => x.id === "p02")).toMatchObject({ role: "admin", title: "課長", baseMin: 480, workDays: [1, 2, 3, 4, 5] });
  });

  it("人数の上限を超える取り込みは拒否される", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: t.clock.now().ts + 86400_000 });
    const admin = await t.login("e16");
    const lines = Array.from({ length: 13 }, (_, i) => `q${i},社員${i},営業,,,,,2026-10-01,,,,`);
    const r = (await imp(t, admin, [header, ...lines].join("\n"))).json as ImportResponse;
    expect(r.ok).toBe(false);
  });

  it("parseEmployeeCsv: 既定値（正社員・一般・月〜金・8時間・9:00）", () => {
    const { rows, errors } = parseEmployeeCsv(`${header}\nz1,名前,部署,,,,,2026-04-01,,,,`, new Set());
    expect(errors).toEqual([]);
    expect(rows[0]!.data).toMatchObject({ kind: "正社員", role: "employee", workDays: [1, 2, 3, 4, 5], baseMin: 480, schedStart: 540, carry: 0 });
  });
});

describe("会社設定", () => {
  it("特別条項をなしにすると、月45時間超が違反として扱われる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const before = ((await t.call("GET", "/api/dashboard", { cookie: admin })).json as DashboardResponse).watch.find((w) => w.emp.id === "e05");
    expect(before?.risk.alerts.some((a) => a.code === "MONTH_OVER_45H" && a.level === "violation")).toBeFalsy();
    expect((await t.call("PATCH", "/api/settings", { cookie: admin, body: { specialClause: false } })).status).toBe(200);
    const list = (await t.call("GET", "/api/attendance?ym=2026-09", { cookie: admin })).json as AttendanceListResponse;
    const e06 = list.rows.find((r) => r.emp.id === "e06")!;
    expect(e06.risk.alerts.some((a) => a.code === "MONTH_OVER_45H" && a.level === "violation")).toBe(true);
    expect(((await t.call("GET", "/api/me", { cookie: admin })).json as MeResponse).settings.specialClause).toBe(false);
  });

  it("協定の起算月を変えると、年累計の集計範囲が変わる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const yearOf = async () => ((await t.call("GET", "/api/attendance?ym=2026-10", { cookie: admin })).json as AttendanceListResponse).rows.find((r) => r.emp.id === "e06")!.risk.yearOvertime;
    const apr = await yearOf();
    expect((await t.call("PATCH", "/api/settings", { cookie: admin, body: { fyStartMonth: 10 } })).status).toBe(200);
    expect(await yearOf()).toBeLessThan(apr); // 10月起算なら、年の集計は10月分だけになる
    expect((await t.call("PATCH", "/api/settings", { cookie: admin, body: { fyStartMonth: 13 } })).status).toBe(400);
  });

  it("会社名を変更できる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { name: "新社名株式会社" } });
    expect(((await t.call("GET", "/api/me", { cookie: admin })).json as MeResponse).tenant.name).toBe("新社名株式会社");
  });

  it("会社の休日を追加すると、その日は欠勤扱いにならず、削除すると戻る", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    // 2026-09-30(水) は出勤日。誰も出勤していない日にして、休日にしたとき欠勤が消えることを確認する
    t.db.prepare("DELETE FROM punch_events WHERE date = '2026-09-30'").run();
    const absent = async () => (await t.call("GET", "/api/attendance/e03?ym=2026-09", { cookie: admin })).json.month.absentDays as number;
    const base = await absent();
    expect((await t.call("POST", "/api/settings/holidays", { cookie: admin, body: { date: "2026-09-30", name: "創立記念日" } })).status).toBe(201);
    expect(await absent()).toBe(base - 1);
    const s = (await t.call("GET", "/api/settings", { cookie: admin })).json as SettingsResponse;
    expect(s.holidays.find((h) => h.date === "2026-09-30")).toEqual({ date: "2026-09-30", name: "創立記念日", kind: "company" });
    expect((await t.call("DELETE", "/api/settings/holidays/2026-09-30", { cookie: admin })).status).toBe(200);
    expect(await absent()).toBe(base);
    expect((await t.call("DELETE", "/api/settings/holidays/2026-09-30", { cookie: admin })).status).toBe(404);
  });

  it("国民の祝日を削除すると、その会社では出勤日として扱われる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    t.db.prepare("DELETE FROM punch_events WHERE date = '2026-09-21'").run();
    const days = async () => (await t.call("GET", "/api/attendance/e03?ym=2026-09", { cookie: admin })).json.days as { plan: { date: string; kind: string } }[];
    expect((await days()).find((d) => d.plan.date === "2026-09-21")?.plan.kind).toBe("off"); // 敬老の日
    await t.call("DELETE", "/api/settings/holidays/2026-09-21", { cookie: admin });
    expect((await days()).find((d) => d.plan.date === "2026-09-21")?.plan.kind).toBe("absent");
  });

  it("一般社員は設定を見られず、不正な入力は拒否される", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await t.call("GET", "/api/settings", { cookie: await t.login("e01") })).status).toBe(403);
    const admin = await t.login("e16");
    expect((await t.call("POST", "/api/settings/holidays", { cookie: admin, body: { date: "2026-02-30", name: "x" } })).status).toBe(400);
    expect((await t.call("POST", "/api/settings/holidays", { cookie: admin, body: { date: "2026-09-30", name: "" } })).status).toBe(400);
  });
});
