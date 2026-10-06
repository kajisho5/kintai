import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AttendanceListResponse, MeResponse } from "../domain";
import { HOLIDAYS_JP } from "../domain/holidays-jp";
import { TenantManager, validateCode } from "./control";
import { openDb } from "./db";
import { syncNationalHolidays } from "./holidays";
import { MIGRATIONS, migrate } from "./migrations";
import { PASSWORD, setup } from "./testkit";

const signup = (t: ReturnType<typeof setup>, over: Record<string, unknown> = {}) =>
  t.call("POST", "/api/signup", {
    body: {
      companyName: "アクメ工業株式会社",
      code: "acme",
      adminName: "青木 一郎",
      email: "aoki@example.com",
      password: "long-enough-pass-1",
      acceptTerms: true,
      ...over,
    },
  });

describe("会社登録", () => {
  it("登録すると無料トライアルで始まり、そのままログインした状態になる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const r = await signup(t);
    expect(r.status).toBe(201);
    const cookie = r.res.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await t.call("GET", "/api/me", { cookie })).json as MeResponse;
    expect(me.employee).toMatchObject({ id: "admin", name: "青木 一郎", role: "admin" });
    expect(me.tenant).toMatchObject({ code: "acme", name: "アクメ工業株式会社", state: "trialing", writable: true, seatsUsed: 1, seatLimit: 30 });
    expect(me.tenant.trialDaysLeft).toBe(30);
    expect(me.settings).toEqual({ fyStartMonth: 4, specialClause: true });
  });

  it("入力の検証: 企業ID・パスワード・メール・規約同意", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await signup(t, { code: "ab" })).status).toBe(400);
    expect((await signup(t, { code: "-acme" })).status).toBe(400);
    expect((await signup(t, { code: "admin" })).status).toBe(400); // 予約語
    expect((await signup(t, { code: "demo" })).status).toBe(400); // 予約語
    expect((await signup(t, { password: "short" })).status).toBe(400);
    expect((await signup(t, { email: "not-an-email" })).status).toBe(400);
    expect((await signup(t, { acceptTerms: false })).status).toBe(400);
    expect((await signup(t, { adminId: "bad id!" })).status).toBe(400);
  });

  it("同じ企業IDでは登録できず、大文字は小文字に正規化される", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await signup(t, { code: "Acme" })).status).toBe(201);
    expect((await signup(t, { code: "acme" })).status).toBe(409);
    expect(t.manager.list().filter((x) => x.code === "acme")).toHaveLength(1);
  });

  it("企業IDの空き状況を確認できる", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await t.call("GET", "/api/signup/check?code=newco")).json).toEqual({ available: true });
    expect((await t.call("GET", "/api/signup/check?code=demo")).json.available).toBe(false);
    expect((await t.call("GET", "/api/signup/check?code=x")).json.available).toBe(false);
  });

  it("登録の連続試行は制限される", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    for (let i = 0; i < 10; i++) await signup(t, { code: `co-${i}a` });
    expect((await signup(t, { code: "another" })).status).toBe(429);
  });

  it("登録した会社には国民の祝日が入っている", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    await signup(t);
    const db = t.manager.db(t.manager.findByCode("acme")!.id);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM holidays WHERE kind = 'national'").get() as { n: number }).n;
    expect(n).toBe(HOLIDAYS_JP.length);
  });
});

describe("会社間の分離", () => {
  it("同じ社員IDでも会社が違えば別人で、他社のデータは見えない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    await signup(t, { code: "acme" });
    await signup(t, { code: "beta", companyName: "ベータ商事", email: "b@example.com", password: "another-long-pass-2" });
    const acme = await t.login("admin", "long-enough-pass-1", "acme");
    const beta = await t.login("admin", "another-long-pass-2", "beta");
    const meA = (await t.call("GET", "/api/me", { cookie: acme })).json as MeResponse;
    const meB = (await t.call("GET", "/api/me", { cookie: beta })).json as MeResponse;
    expect(meA.tenant.name).toBe("アクメ工業株式会社");
    expect(meB.tenant.name).toBe("ベータ商事");
    // 他社のパスワードでは入れない
    expect((await t.call("POST", "/api/auth/login", { body: { company: "acme", id: "admin", password: "another-long-pass-2" } })).status).toBe(401);
    // デモ会社の18名は acme から見えない
    const list = (await t.call("GET", "/api/attendance?ym=2026-10", { cookie: acme })).json as AttendanceListResponse;
    expect(list.rows.map((r) => r.emp.id)).toEqual(["admin"]);
  });

  it("Cookie の会社部分を他社に書き換えても入れない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    await signup(t, { code: "acme" });
    const acme = await t.login("admin", "long-enough-pass-1", "acme");
    const token = acme.split("=")[1]!.split(".")[1]!;
    const forged = `sid=${t.tenant.id}.${token}`; // demo 会社の ID に付け替え
    expect((await t.call("GET", "/api/me", { cookie: forged })).status).toBe(401);
    expect((await t.call("GET", "/api/me", { cookie: "sid=garbage" })).status).toBe(401);
    expect((await t.call("GET", "/api/me", { cookie: "sid=.x" })).status).toBe(401);
  });

  it("存在しない企業IDと誤ったパスワードで同じメッセージを返す", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const a = await t.call("POST", "/api/auth/login", { body: { company: "nonexistent", id: "e01", password: PASSWORD } });
    const b = await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e01", password: "wrong-password" } });
    expect(a.status).toBe(401);
    expect(a.json.error).toBe(b.json.error);
  });
});

describe("契約状態による制限", () => {
  it("トライアル終了後は閲覧だけでき、変更は 402 になる（パスワード変更は可能）", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const cookie = await t.login("e01");
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: t.clock.now().ts - 1000 });
    const me = (await t.call("GET", "/api/me", { cookie })).json as MeResponse;
    expect(me.tenant).toMatchObject({ state: "trial_expired", writable: false });
    expect((await t.call("GET", "/api/punch/today", { cookie })).status).toBe(200);
    const w = await t.call("POST", "/api/punch", { cookie, body: { action: "in" } });
    expect(w.status).toBe(402);
    expect(w.json.code).toBe("TRIAL_EXPIRED");
    expect((await t.call("POST", "/api/auth/password", { cookie, body: { current: PASSWORD, next: "new-password-99" } })).status).toBe(200);
  });

  it("契約するとすぐ変更できるようになる", async () => {
    const t = setup({ nowMin: -1, at: "09:00" });
    const cookie = await t.login("e01");
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: 1 });
    expect((await t.call("POST", "/api/punch", { cookie, body: { action: "in" } })).status).toBe(402);
    t.manager.update(t.tenant.id, { status: "active" });
    expect((await t.call("POST", "/api/punch", { cookie, body: { action: "in" } })).status).toBe(200);
  });

  it("解約後は閲覧のみ、停止中はログインもできない", async () => {
    const t = setup({ nowMin: -1, at: "09:00" });
    const cookie = await t.login("e01");
    t.manager.update(t.tenant.id, { status: "canceled" });
    expect((await t.call("POST", "/api/punch", { cookie, body: { action: "in" } })).status).toBe(402);
    expect((await t.call("GET", "/api/leave", { cookie })).status).toBe(200);
    t.manager.update(t.tenant.id, { status: "suspended" });
    expect((await t.call("GET", "/api/me", { cookie })).status).toBe(403);
    expect((await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e01", password: PASSWORD } })).status).toBe(403);
  });
});

describe("マイグレーションと祝日", () => {
  it("途中までのDBに最新のスキーマを適用しても、既存のデータは残る。2回目は何もしない", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, MIGRATIONS.slice(0, 1));
    db.exec(
      "INSERT INTO employees (id, name, dept, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, password_hash) VALUES ('x', '旧データ', '営業', '正社員', 'admin', '[1]', 1, 8, 480, 540, '2020-04-01', 'h')",
    );
    expect(migrate(db)).toEqual([2, 3]);
    const row = db.prepare("SELECT name, must_change_password AS m, email FROM employees WHERE id = 'x'").get() as { name: string; m: number; email: string | null };
    expect(row).toEqual({ name: "旧データ", m: 0, email: null });
    expect(migrate(db)).toEqual([]);
  });

  it("国民の祝日を取り込む。管理者が削除した祝日は再同期で復活しない", () => {
    const db = openDb(":memory:");
    syncNationalHolidays(db);
    expect(db.prepare("SELECT name FROM holidays WHERE date = '2026-10-12'").get()).toEqual({ name: "スポーツの日" });
    db.prepare("DELETE FROM holidays WHERE date = '2026-10-12'").run();
    syncNationalHolidays(db);
    expect(db.prepare("SELECT name FROM holidays WHERE date = '2026-10-12'").get()).toBeUndefined();
  });

  it("新しい年のデータが増えたときだけ追加される", () => {
    const db = openDb(":memory:");
    syncNationalHolidays(db);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('holidays_synced_year', '2026')").run();
    db.prepare("DELETE FROM holidays WHERE date LIKE '2026-%' OR date LIKE '2027-%'").run();
    syncNationalHolidays(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM holidays WHERE date LIKE '2026-%'").get()).toEqual({ n: 0 }); // 取り込み済みの年は触らない
    expect((db.prepare("SELECT COUNT(*) AS n FROM holidays WHERE date LIKE '2027-%'").get() as { n: number }).n).toBeGreaterThan(10);
  });
});

describe("会社ごとのDBファイル", () => {
  it("会社ごとに別のファイルができ、ファイル名は企業IDではなく内部IDになる", () => {
    const dir = mkdtempSync(join(tmpdir(), "tenants-"));
    const m = new TenantManager(join(dir, "control.db"), join(dir, "tenants"));
    const a = m.create({ code: "../evil", name: "A", adminEmail: "a@example.com", nowMs: 1 }); // 危険な文字列でもパスには使われない
    const b = m.create({ code: "bbb", name: "B", adminEmail: "b@example.com", nowMs: 1 });
    m.db(a.id);
    m.db(b.id);
    expect(existsSync(join(dir, "tenants", `${a.id}.db`))).toBe(true);
    expect(readdirSync(join(dir, "tenants")).filter((f) => f.endsWith(".db"))).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
    m.close();
  });

  it("企業IDの形式検証", () => {
    expect(validateCode("acme-1")).toBeUndefined();
    expect(validateCode("Acme")).toBeDefined();
    expect(validateCode("a--")).toBeDefined();
    expect(validateCode("日本語")).toBeDefined();
    expect(validateCode("a".repeat(33))).toBeDefined();
  });
});

describe("ヘルスチェック", () => {
  it("未ログインでも応答する", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await t.call("GET", "/api/health")).json).toEqual({ ok: true });
  });
});
