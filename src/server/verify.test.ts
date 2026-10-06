import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CONTROL_MIGRATIONS, TenantManager } from "./control";
import { runJobs } from "./jobs";
import { migrate } from "./migrations";
import { FakeBilling, setup } from "./testkit";

const PW = "long-enough-pass-1";
const tokenOf = (mail: { text: string }): string => /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;

/** 会社を登録し、管理者としてログインした状態にする（登録時のメールは mailer.sent[0]） */
async function signedUp(opts: { appUrl?: string | null } = {}) {
  const t = setup({ nowMin: 840, at: "14:00", billing: new FakeBilling(), ...opts });
  const r = await t.call("POST", "/api/signup", {
    body: { companyName: "アクメ工業", code: "acme", adminName: "青木 一郎", email: "Aoki@Example.com", password: PW, acceptTerms: true },
  });
  expect(r.status).toBe(201);
  await new Promise((res) => setTimeout(res, 0));
  const cookie = r.res.headers.get("set-cookie")!.split(";")[0]!;
  return { t, cookie, tenant: () => t.manager.findByCode("acme")! };
}
const verify = (t: ReturnType<typeof setup>, token: string, company = "acme") => t.call("POST", "/api/signup/verify", { body: { company, token } });

describe("登録時のメールアドレス確認", () => {
  it("登録すると確認リンク入りのメールが届き、リンクを開くまで未確認。開くと確認済みになる", async () => {
    const { t, cookie, tenant } = await signedUp();
    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.sent[0]!;
    expect(mail.to).toBe("aoki@example.com");
    expect(mail.text).toContain("https://app.example.com/app/#/verify?company=acme&token=");
    expect(mail.text).toContain("企業ID: acme");
    expect(mail.text).not.toContain(PW);

    const before = await t.call("GET", "/api/me", { cookie });
    expect(before.json.tenant.emailVerified).toBe(false);
    expect(before.json.tenant.adminEmail).toBe("aoki@example.com");
    expect(tenant().adminEmailVerifiedAt).toBeUndefined();

    expect((await verify(t, tokenOf(mail))).status).toBe(200);
    const after = await t.call("GET", "/api/me", { cookie });
    expect(after.json.tenant.emailVerified).toBe(true);
    expect(after.json.tenant.adminEmail).toBeUndefined(); // 確認後は返さない
    expect(tenant().adminEmailVerifiedAt).toBe(t.clock.now().ts);
  });

  it("同じリンクをもう一度開いても成功する（二重クリック・再読み込み）。確認の記録は残る", async () => {
    const { t } = await signedUp();
    const token = tokenOf(t.mailer.sent[0]!);
    expect((await verify(t, token)).status).toBe(200);
    expect((await verify(t, token)).status).toBe(200);
    const acme = t.manager.findByCode("acme")!;
    const logs = t.manager.db(acme.id).prepare("SELECT action FROM audit_log WHERE action = 'email_verified'").all();
    expect(logs).toHaveLength(2);
  });

  it("誤ったトークン・別の会社・期限（24時間）切れでは確認できない", async () => {
    const { t, tenant } = await signedUp();
    const token = tokenOf(t.mailer.sent[0]!);
    expect((await verify(t, "x".repeat(43))).status).toBe(400);
    expect((await verify(t, token, "demo")).status).toBe(400); // 他社のトークンとしては使えない
    expect((await verify(t, token, "nonexistent")).status).toBe(400);
    expect(tenant().adminEmailVerifiedAt).toBeUndefined();

    t.clock.set("2026-10-07", "14:01"); // 24時間と1分後
    expect((await verify(t, token)).status).toBe(400);
    expect(tenant().adminEmailVerifiedAt).toBeUndefined();
  });

  it("再送すると前のリンクは使えなくなり、最新のリンクだけが有効", async () => {
    const { t, cookie } = await signedUp();
    const first = tokenOf(t.mailer.sent[0]!);
    expect((await t.call("POST", "/api/auth/verify/resend", { cookie, body: {} })).status).toBe(200);
    expect(t.mailer.sent).toHaveLength(2);
    expect(t.mailer.sent[1]!.to).toBe("aoki@example.com");
    expect((await verify(t, first)).status).toBe(400);
    expect((await verify(t, tokenOf(t.mailer.sent[1]!))).status).toBe(200);
  });

  it("入力ミスはメールアドレスを直して再送できる。古いアドレス宛のリンクは使えず、新しいアドレスで確認できる", async () => {
    const { t, cookie, tenant } = await signedUp();
    const old = tokenOf(t.mailer.sent[0]!);
    const r = await t.call("POST", "/api/auth/verify/resend", { cookie, body: { email: "Right@Example.com" } });
    expect(r.status).toBe(200);
    expect(r.json.email).toBe("right@example.com");
    expect(t.mailer.sent[1]!.to).toBe("right@example.com");
    expect(tenant().adminEmail).toBe("right@example.com");
    const acme = tenant();
    expect(t.manager.db(acme.id).prepare("SELECT email FROM employees WHERE id = 'admin'").get()).toEqual({ email: "right@example.com" });

    expect((await verify(t, old)).status).toBe(400);
    expect((await verify(t, tokenOf(t.mailer.sent[1]!))).status).toBe(200);
  });

  it("送り先の変更でも、同じアドレス宛の上限（登録と合わせて24時間3回）を超えて送れない", async () => {
    const { t, cookie } = await signedUp();
    const body = (code: string) => ({ companyName: "別会社", code, adminName: "別人", email: "victim@example.com", password: "long-enough-pass-1", acceptTerms: true });
    expect((await t.call("POST", "/api/signup", { body: body("other-a") })).status).toBe(201); // victim@ 宛に1通目
    expect((await t.call("POST", "/api/signup", { body: body("other-b") })).status).toBe(201); // 2通目
    const resend = (email: string) => t.call("POST", "/api/auth/verify/resend", { cookie, body: { email } });
    expect((await resend("victim@example.com")).status).toBe(200); // 3通目
    expect((await resend("aoki@example.com")).status).toBe(200);
    const blocked = await resend("victim@example.com");
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toContain("メールアドレス宛");
    expect(t.mailer.sent.filter((m) => m.to === "victim@example.com")).toHaveLength(3);
  });

  it("アドレスが変更された後は、変更前のアドレス宛のリンクでは確認できない（他の経路で変わった場合も）", async () => {
    const { t, tenant } = await signedUp();
    const token = tokenOf(t.mailer.sent[0]!);
    t.manager.changeAdminEmail(tenant().id, "changed@example.com");
    expect((await verify(t, token)).status).toBe(400);
    expect(tenant().adminEmailVerifiedAt).toBeUndefined();
  });

  it("確認済みの会社は再送できない。管理者以外・未ログインも不可。不正な形式は拒否", async () => {
    const { t, cookie } = await signedUp();
    expect((await t.call("POST", "/api/auth/verify/resend", { body: {} })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/verify/resend", { cookie, body: { email: "not-an-email" } })).status).toBe(400);

    // 管理者以外
    const acme = t.manager.findByCode("acme")!;
    const adb = t.manager.db(acme.id);
    adb.exec("UPDATE employees SET role = 'admin'"); // 一時的にそのまま。別の社員を作る
    adb.prepare(
      `INSERT INTO employees (id, name, dept, title, kind, role, work_days, weekly_days, weekly_hours, base_min, sched_start, hired, carry, password_hash)
       SELECT 'w01', '社員', '営', '', '正社員', 'employee', work_days, weekly_days, weekly_hours, base_min, sched_start, hired, 0, password_hash FROM employees WHERE id = 'admin'`,
    ).run();
    const login = await t.call("POST", "/api/auth/login", { body: { company: "acme", id: "w01", password: PW } });
    const wcookie = login.res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await t.call("POST", "/api/auth/verify/resend", { cookie: wcookie, body: {} })).status).toBe(403);
    const me = await t.call("GET", "/api/me", { cookie: wcookie });
    expect(me.json.tenant.adminEmail).toBeUndefined(); // 一般社員には確認先を見せない

    expect((await verify(t, tokenOf(t.mailer.sent[0]!))).status).toBe(200);
    expect((await t.call("POST", "/api/auth/verify/resend", { cookie, body: {} })).status).toBe(409);
  });

  it("再送は1時間に5回まで", async () => {
    const { t, cookie } = await signedUp();
    for (let i = 0; i < 5; i++) expect((await t.call("POST", "/api/auth/verify/resend", { cookie, body: {} })).status).toBe(200);
    expect((await t.call("POST", "/api/auth/verify/resend", { cookie, body: {} })).status).toBe(429);
  });

  it("メールの送信に失敗したら、その旨を返す（利用者に成功と誤解させない）", async () => {
    const { t, cookie } = await signedUp();
    t.mailer.send = async () => {
      throw new Error("smtp down");
    };
    const r = await t.call("POST", "/api/auth/verify/resend", { cookie, body: {} });
    expect(r.status).toBe(502);
  });

  it("未確認の間はお申し込み（決済）に進めない。確認すれば進める", async () => {
    const { t, cookie } = await signedUp();
    const blocked = await t.call("POST", "/api/billing/checkout", { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("EMAIL_UNVERIFIED");
    expect((await t.call("GET", "/api/billing", { cookie })).json.emailVerified).toBe(false);
    expect((t.billing as FakeBilling).calls).toHaveLength(0);

    await verify(t, tokenOf(t.mailer.sent[0]!));
    expect((await t.call("GET", "/api/billing", { cookie })).json.emailVerified).toBe(true);
    expect((await t.call("POST", "/api/billing/checkout", { cookie })).status).toBe(200);
  });

  it("未確認でも無料トライアルの機能（打刻など）は使える", async () => {
    const { t, cookie } = await signedUp();
    expect((await t.call("POST", "/api/punch", { cookie, body: { action: "in" } })).status).toBe(200);
  });

  it("未確認の会社には、パスワード再設定のメールもトライアル終了の案内も送らない", async () => {
    const { t, tenant } = await signedUp();
    const mails = t.mailer.sent.length;
    const r = await t.call("POST", "/api/auth/forgot", { body: { company: "acme", email: "aoki@example.com" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    t.manager.update(tenant().id, { trialEndsAt: t.clock.now().ts + 2 * 86400_000 });
    const deps = { manager: t.manager, mailer: t.mailer, billing: t.billing, clockFor: () => t.clock, appUrl: t.appUrl };
    expect((await runJobs(deps)).reminders).toBe(0);
    expect(t.mailer.sent).toHaveLength(mails);

    await verify(t, tokenOf(t.mailer.sent[0]!));
    expect((await runJobs(deps)).reminders).toBe(1);
    await t.call("POST", "/api/auth/forgot", { body: { company: "acme", email: "aoki@example.com" } });
    expect(t.mailer.sent.at(-1)!.text).toContain("パスワードの再設定");
  });

  it("メールを送れない環境（APP_URL 未設定）では、確認の手段がないため確認済みとして登録される", async () => {
    const { t, cookie, tenant } = await signedUp({ appUrl: null });
    expect(t.mailer.sent).toHaveLength(0);
    expect(tenant().adminEmailVerifiedAt).toBeDefined();
    expect((await t.call("GET", "/api/me", { cookie })).json.tenant.emailVerified).toBe(true);
  });

  it("確認用の試行はIPごとに制限される", async () => {
    const { t } = await signedUp();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await verify(t, "y".repeat(43))).status;
    expect(last).toBe(429);
  });

  it("期限切れの確認トークンは定期ジョブで削除される", async () => {
    const { t } = await signedUp();
    const deps = { manager: t.manager, mailer: t.mailer, billing: t.billing, clockFor: () => t.clock, appUrl: t.appUrl };
    expect((await runJobs(deps)).cleaned).toBe(0); // まだ有効
    t.clock.set("2026-10-09", "14:00");
    expect((await runJobs(deps)).cleaned).toBeGreaterThan(0);
  });

  it("会社を削除すると、その確認トークンも消える", async () => {
    const { t, tenant } = await signedUp();
    const token = tokenOf(t.mailer.sent[0]!);
    t.manager.purge(tenant().id);
    expect((await verify(t, token)).status).toBe(400);
  });

  it("この機能より前に登録された会社は、確認済みとして引き継がれる", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, CONTROL_MIGRATIONS.slice(0, 2));
    db.prepare(
      "INSERT INTO tenants (id, code, name, tz, status, trial_ends_at, admin_email, created_at) VALUES ('t1', 'old', '旧', 'Asia/Tokyo', 'active', 1, 'o@example.com', 1234)",
    ).run();
    migrate(db, CONTROL_MIGRATIONS);
    expect(db.prepare("SELECT admin_email_verified_at AS v FROM tenants WHERE id = 't1'").get()).toEqual({ v: 1234 });
    const m = new TenantManager(":memory:", ":memory:");
    expect(m.create({ code: "fresh", name: "新", adminEmail: "n@example.com", nowMs: 5 }).adminEmailVerifiedAt).toBeUndefined();
  });
});
