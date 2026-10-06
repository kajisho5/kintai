import { describe, expect, it } from "vitest";
import { PASSWORD, setup } from "./testkit";

const tokenOf = (mail: { text: string }): string => /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;

function withEmails() {
  const t = setup({ nowMin: 840, at: "14:00" });
  t.db.exec("UPDATE employees SET email = 'e01@example.com' WHERE id = 'e01'");
  return t;
}
const forgot = (t: ReturnType<typeof setup>, body: Record<string, unknown>) => t.call("POST", "/api/auth/forgot", { body: { company: "demo", ...body } });

describe("パスワードの再設定", () => {
  it("登録メールアドレス宛にリンクが届き、新しいパスワードで入れる。古いパスワードとセッションは無効になる", async () => {
    const t = withEmails();
    const old = await t.login("e01");
    expect((await forgot(t, { email: "E01@example.com" })).status).toBe(200); // 大文字小文字は区別しない
    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.sent[0]!;
    expect(mail.to).toBe("e01@example.com");
    expect(mail.text).toContain("https://app.example.com/#/reset?company=demo&token=");
    expect(mail.text).not.toContain(PASSWORD);

    const r = await t.call("POST", "/api/auth/reset", { body: { company: "demo", token: tokenOf(mail), password: "brand-new-pass-1" } });
    expect(r.status).toBe(200);
    expect((await t.call("GET", "/api/me", { cookie: old })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e01", password: PASSWORD } })).status).toBe(401);
    expect((await t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e01", password: "brand-new-pass-1" } })).status).toBe(200);
  });

  it("登録のないメールアドレス・存在しない会社でも同じ応答を返し、メールは送られない", async () => {
    const t = withEmails();
    const a = await forgot(t, { email: "nobody@example.com" });
    const b = await forgot(t, { company: "nonexistent", email: "e01@example.com" });
    expect(a.status).toBe(200);
    expect(b.json).toEqual(a.json);
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("リンクは1回だけ使え、期限（60分）を過ぎると使えない。別の会社では使えない", async () => {
    const t = withEmails();
    await forgot(t, { email: "e01@example.com" });
    const token = tokenOf(t.mailer.sent[0]!);
    expect((await t.call("POST", "/api/auth/reset", { body: { company: "other", token, password: "brand-new-pass-1" } })).status).toBe(400);
    expect((await t.call("POST", "/api/auth/reset", { body: { company: "demo", token, password: "brand-new-pass-1" } })).status).toBe(200);
    expect((await t.call("POST", "/api/auth/reset", { body: { company: "demo", token, password: "another-pass-123" } })).status).toBe(400);

    t.db.exec("UPDATE employees SET email = 'e02@example.com' WHERE id = 'e02'");
    await forgot(t, { email: "e02@example.com" });
    t.clock.set("2026-10-06", "15:30"); // 90分後
    expect((await t.call("POST", "/api/auth/reset", { body: { company: "demo", token: tokenOf(t.mailer.sent[1]!), password: "brand-new-pass-1" } })).status).toBe(400);
  });

  it("でたらめなトークン・短いパスワードは拒否される", async () => {
    const t = withEmails();
    await forgot(t, { email: "e01@example.com" });
    const token = tokenOf(t.mailer.sent[0]!);
    expect((await t.call("POST", "/api/auth/reset", { body: { company: "demo", token: "x".repeat(43), password: "brand-new-pass-1" } })).status).toBe(400);
    expect((await t.call("POST", "/api/auth/reset", { body: { company: "demo", token, password: "short" } })).status).toBe(400);
  });

  it("一時パスワードのままの人も、再設定すれば通常の状態になる", async () => {
    const t = withEmails();
    t.db.exec("UPDATE employees SET must_change_password = 1 WHERE id = 'e01'");
    await forgot(t, { email: "e01@example.com" });
    await t.call("POST", "/api/auth/reset", { body: { company: "demo", token: tokenOf(t.mailer.sent[0]!), password: "brand-new-pass-1" } });
    const c = await t.login("e01", "brand-new-pass-1");
    expect((await t.call("GET", "/api/punch/today", { cookie: c })).status).toBe(200);
  });

  it("退職した人には届かない", async () => {
    const t = withEmails();
    t.db.exec("UPDATE employees SET active = 0 WHERE id = 'e01'");
    await forgot(t, { email: "e01@example.com" });
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("同じ宛先への連続申請は制限される", async () => {
    const t = withEmails();
    for (let i = 0; i < 3; i++) expect((await forgot(t, { email: "e01@example.com" })).status).toBe(200);
    expect((await forgot(t, { email: "e01@example.com" })).status).toBe(429);
    expect(t.mailer.sent).toHaveLength(3);
  });

  it("公開URL（APP_URL）が未設定なら、リンクを作らずメールも送らない", async () => {
    const t = setup({ nowMin: 840, at: "14:00", appUrl: null });
    t.db.exec("UPDATE employees SET email = 'e01@example.com' WHERE id = 'e01'");
    expect((await forgot(t, { email: "e01@example.com" })).status).toBe(200);
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("Host ヘッダを偽装しても、リンクは設定済みの公開URLになる", async () => {
    const t = withEmails();
    await t.call("POST", "/api/auth/forgot", { body: { company: "demo", email: "e01@example.com" }, headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
    expect(t.mailer.sent[0]!.text).toContain("https://app.example.com/");
    expect(t.mailer.sent[0]!.text).not.toContain("evil.example");
  });
});

describe("登録メール", () => {
  it("会社登録すると、管理者にログイン情報の案内が届く", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    await t.call("POST", "/api/signup", {
      body: { companyName: "アクメ工業", code: "acme", adminName: "青木 一郎", email: "aoki@example.com", password: "long-enough-pass-1", acceptTerms: true },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]!.to).toBe("aoki@example.com");
    expect(t.mailer.sent[0]!.text).toContain("企業ID: acme");
    expect(t.mailer.sent[0]!.text).not.toContain("long-enough-pass-1");
  });
});
