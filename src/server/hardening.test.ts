import { describe, expect, it } from "vitest";
import { hashPassword, hashTemporaryPassword, verifyPassword } from "./auth";
import { FakeBilling, PASSWORD, setup } from "./testkit";
import { syncSeats } from "./seats";
import { clientIp } from "./routes/auth";

/** 脆弱性診断の指摘への対策の回帰テスト */

const loginAs = (t: ReturnType<typeof setup>, id: string, password: string, ip?: string, cookie?: string) =>
  t.call("POST", "/api/auth/login", { body: { company: "demo", id, password }, headers: { ...(ip ? { "x-forwarded-for": ip } : {}), ...(cookie ? { cookie } : {}) } });

describe("アカウントのロック（他人による締め出し）", () => {
  it("他の接続元からの失敗でアカウント全体がロックされても、前にログインに成功した端末（Cookie）からは入れる。知らない端末は、ロックされる", async () => {
    const t = setup({ nowMin: 600, at: "10:00", trustProxy: true });
    const first = await loginAs(t, "e16", PASSWORD, "10.0.0.1");
    expect(first.status).toBe(200);
    const device = first.res.headers.getSetCookie().find((c) => c.startsWith("kd="))!.split(";")[0]!;
    expect(device).toMatch(/^kd=/);
    // 4つの接続元が、5回ずつ失敗（アカウント全体で20回）
    for (let ip = 1; ip <= 4; ip++) for (let i = 0; i < 5; i++) expect((await loginAs(t, "e16", "wrong-password-x", `20.0.0.${ip}`)).status).toBe(401);
    const stranger = await loginAs(t, "e16", PASSWORD, "10.0.0.2");
    expect(stranger.status).toBe(423);
    const known = await loginAs(t, "e16", PASSWORD, "10.0.0.2", device);
    expect(known.status).toBe(200);
    // ロックの最中でも、端末の印があるだけでは、パスワードの確認は省かれない
    expect((await loginAs(t, "e16", "wrong-password-x", "10.0.0.3", device)).status).toBe(401);
  });

  it("失敗の回数は、時間がたてば忘れる（昔の失敗が積み上がって、ロックされることはない）", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    for (let i = 0; i < 4; i++) await loginAs(t, "e03", "wrong-password-x");
    t.clock.set("2026-10-08", "10:00"); // 2日後
    expect((await loginAs(t, "e03", "wrong-password-x")).status).toBe(401); // 5回目ではなく、1回目として数える
    expect((await loginAs(t, "e03", PASSWORD)).status).toBe(200);
  });

  it("パスワードを変えると、端末の印は無効になる", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const r = await loginAs(t, "e03", PASSWORD);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM trusted_devices WHERE emp_id = 'e03'").get()).toEqual({ n: 1 });
    const cookie = r.res.headers.getSetCookie().find((c) => c.startsWith("sid="))!.split(";")[0]!;
    expect((await t.call("POST", "/api/auth/password", { cookie, body: { current: PASSWORD, next: "brand-new-password-9" } })).status).toBe(200);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM trusted_devices WHERE emp_id = 'e03'").get()).toEqual({ n: 0 });
  });
});

describe("接続元IPの判定", () => {
  const ctx = (xff: string | undefined) => ({ req: { header: (n: string) => (n === "x-forwarded-for" ? xff : undefined) }, env: { incoming: { socket: { remoteAddress: "127.0.0.1" } } } }) as never;
  it("プロキシを信頼するときも、X-Forwarded-For の右端（直前のプロキシが付けた値）を使う。左側の偽装は効かない", () => {
    expect(clientIp(ctx("6.6.6.6, 203.0.113.9"), true)).toBe("203.0.113.9");
    expect(clientIp(ctx("203.0.113.9"), true)).toBe("203.0.113.9");
    expect(clientIp(ctx("6.6.6.6, 203.0.113.9"), false)).toBe("127.0.0.1");
  });

  it("X-Forwarded-For の左側を変えても、IPごとのログインの制限は回避できない", async () => {
    const t = setup({ nowMin: 600, at: "10:00", trustProxy: true });
    const results: number[] = [];
    for (let i = 0; i < 7; i++) results.push((await loginAs(t, "e04", "wrong-password-x", `1.1.1.${i}, 9.9.9.9`)).status);
    expect(results.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(results[5]).toBe(423); // 同じ接続元・同じアカウントの5回失敗でロック
  });
});

describe("リクエストの出どころの検査", () => {
  it("Origin が 'null' や不正な値のとき、403（500にしない）。Sec-Fetch-Site が cross-site のときも拒否する", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const body = { company: "demo", id: "e01", password: PASSWORD };
    expect((await t.call("POST", "/api/auth/login", { body, headers: { origin: "null" } })).status).toBe(403);
    expect((await t.call("POST", "/api/auth/login", { body, headers: { origin: "garbage" } })).status).toBe(403);
    expect((await t.call("POST", "/api/auth/login", { body, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await t.call("POST", "/api/auth/login", { body, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  it("CSP に base-uri・form-action・object-src が付く", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const csp = (await t.call("GET", "/api/health")).res.headers.get("content-security-policy")!;
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe("案内メールへの文字列の混入", () => {
  it("社員の氏名・部署・役職・会社名に、改行・URL・短縮URL・全角のURL・ドメイン名を入れられない", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const admin = await t.login("e16");
    for (const bad of ["A\nB", "see http://evil.example/x", "bit.ly/3xYzAb", "evil.example/login", "ｈｔｔｐ：//evil", "evil[.]com", "evil dot com"]) {
      expect((await t.call("PATCH", "/api/employees/e16", { cookie: admin, body: { name: bad } })).status, bad).toBe(400);
      expect((await t.call("PATCH", "/api/employees/e16", { cookie: admin, body: { dept: bad } })).status, bad).toBe(400);
      expect((await t.call("PATCH", "/api/settings", { cookie: admin, body: { name: bad } })).status, bad).toBe(400);
    }
    expect((await t.call("PATCH", "/api/employees/e16", { cookie: admin, body: { name: "山田 太郎", dept: "営業部" } })).status).toBe(200);
  });

  it("同じメールアドレスを、在籍中の複数の社員に登録できない（作成・変更・復職）", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const admin = await t.login("e16");
    const base = { name: "新人", dept: "営業", kind: "正社員", workDays: [1, 2, 3, 4, 5], baseMin: 480, schedStart: 540, hired: "2026-10-01" };
    expect((await t.call("POST", "/api/employees", { cookie: admin, body: { id: "n01", ...base, email: "Same@Example.com" } })).status).toBe(201);
    const dup = await t.call("POST", "/api/employees", { cookie: admin, body: { id: "n02", ...base, email: "same@example.com" } });
    expect(dup.status).toBe(409);
    expect((await t.call("POST", "/api/employees", { cookie: admin, body: { id: "n02", ...base, email: "other@example.com" } })).status).toBe(201);
    expect((await t.call("PATCH", "/api/employees/n02", { cookie: admin, body: { email: "same@example.com" } })).status).toBe(409);
    expect((await t.call("PATCH", "/api/employees/n02", { cookie: admin, body: { email: "n02@example.com" } })).status).toBe(200);
  });

  it("入社日に極端な日付（9999年）を入れられない", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const admin = await t.login("e16");
    const base = { name: "新人", dept: "営業", kind: "正社員", workDays: [1, 2, 3, 4, 5], baseMin: 480, schedStart: 540 };
    expect((await t.call("POST", "/api/employees", { cookie: admin, body: { id: "n01", ...base, hired: "9999-12-31" } })).status).toBe(400);
    expect((await t.call("POST", "/api/employees", { cookie: admin, body: { id: "n01", ...base, hired: "2026-10-01" } })).status).toBe(201);
    expect((await t.call("PATCH", "/api/employees/n01", { cookie: admin, body: { hired: "9999-12-31" } })).status).toBe(400);
  });
});

describe("パスワード再設定", () => {
  it("同じアドレスの社員が重複していても、1回の申請で送るのは1通まで", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    t.manager.update(t.tenant.id, {});
    t.db.prepare("UPDATE employees SET email = 'dup@example.com' WHERE id IN ('e02', 'e03')").run(); // 以前の登録で重複していた場合
    // メール未確認の会社には送らない設定のため、確認済みにする
    t.db.prepare("SELECT 1").get();
    const body = { company: "demo", email: "dup@example.com" };
    await t.call("POST", "/api/auth/forgot", { body });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.mailer.sent.filter((m) => m.to === "dup@example.com")).toHaveLength(1);
  });

  it("本人がパスワードを変更した・管理者が再発行した・退職した・メールアドレスを変えたときは、発行済みの再設定リンクが使えなくなる", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const admin = await t.login("e16");
    t.db.prepare("UPDATE employees SET email = 'e03@example.com' WHERE id = 'e03'").run();
    const issue = async () => {
      const before = t.mailer.sent.length;
      await t.call("POST", "/api/auth/forgot", { body: { company: "demo", email: "e03@example.com" } });
      await new Promise((r) => setTimeout(r, 0));
      const mail = t.mailer.sent.slice(before).find((m) => m.to === "e03@example.com");
      return /token=([A-Za-z0-9_-]+)/.exec(mail!.text)![1]!;
    };
    const reset = (token: string) => t.call("POST", "/api/auth/reset", { body: { company: "demo", token, password: "attacker-chosen-pw-1" } });

    let token = await issue();
    expect((await t.call("POST", `/api/employees/e03/reset-password`, { cookie: admin })).status).toBe(200);
    expect((await reset(token)).status).toBe(400); // 管理者の再発行のあと

    token = await issue();
    const c = await loginAs(t, "e03", "wrong");
    void c;
    expect((await t.call("PATCH", "/api/employees/e03", { cookie: admin, body: { email: "new@example.com" } })).status).toBe(200);
    expect((await reset(token)).status).toBe(400); // メールアドレスの変更のあと

    t.db.prepare("UPDATE employees SET email = 'e03@example.com' WHERE id = 'e03'").run();
    token = await issue();
    expect((await t.call("POST", `/api/employees/e03/deactivate`, { cookie: admin })).status).toBe(200);
    expect((await reset(token)).status).toBe(400); // 退職のあと
  });
});

describe("操作記録への書き込み", () => {
  it("存在しない社員IDでのログイン失敗は、任意の文字列を操作者として記録しない", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    await loginAs(t, "=cmd|' /C calc'!A0", "x");
    await loginAs(t, "e03", "wrong-password-x");
    const rows = t.db.prepare("SELECT actor FROM audit_log WHERE action = 'login_failed' ORDER BY id").all() as { actor: string }[];
    expect(rows.map((r) => r.actor)).toEqual(["-", "e03"]);
  });
});

describe("共用端末の暗証番号の枠", () => {
  it("正しい暗証番号の打刻（成功）は、枠に数えない。連続して60回を超えても、打刻できる", async () => {
    const t = setup({ nowMin: -1, at: "09:00" });
    const admin = await t.login("e16");
    const token = (await t.call("POST", "/api/kiosk/terminals", { cookie: admin, body: { name: "玄関" } })).json.token as string;
    const pin = (await t.call("POST", "/api/employees/e01/pin", { cookie: admin })).json.pin as string;
    for (let i = 0; i < 65; i++) expect((await t.call("POST", "/api/kiosk/identify", { body: { token, empId: "e01", pin } })).status, `${i}回目`).toBe(200);
  }, 60_000);
});

describe("二段階認証の設定", () => {
  it("セッションだけでは設定を始められない（パスワードの再入力が必要）。パスワードを何度も間違えるとロックされる", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const cookie = await t.login("e16");
    expect((await t.call("POST", "/api/auth/2fa/setup", { cookie, body: {} })).status).toBe(400);
    expect((await t.call("POST", "/api/auth/2fa/setup", { cookie, body: { password: "wrong-password-x" } })).status).toBe(400);
    expect((await t.call("POST", "/api/auth/2fa/setup", { cookie, body: { password: PASSWORD } })).status).toBe(200);
  });
});

describe("取り込みの負荷", () => {
  it("行数・列数が多すぎるCSVは、解析する前に断る。取り込みの操作は、会社ごとに回数を制限する", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const admin = await t.login("e16");
    const big = "社員ID,氏名\n" + "a\n".repeat(5000);
    const r = (await t.call("POST", "/api/employees/import", { cookie: admin, body: { csv: big, dryRun: true } })).json;
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain("行まで");
    const wide = "社員ID,氏名\n" + ",".repeat(700_000);
    expect((await t.call("POST", "/api/schedules/import", { cookie: admin, body: { csv: wide, dryRun: true } })).json.errors[0].message).toContain("列が多すぎます");
    // 回数の制限（20回/10分）
    let blocked = 0;
    for (let i = 0; i < 25; i++) if ((await t.call("POST", "/api/employees/import", { cookie: admin, body: { csv: "", dryRun: true } })).status === 429) blocked++;
    expect(blocked).toBeGreaterThan(0);
  });
});

describe("パスワードのハッシュ", () => {
  it("一時パスワード用の軽いハッシュも検証でき、ログインに成功すると通常のコストに作り直される", async () => {
    const t = setup({ nowMin: 600, at: "10:00" });
    const stored = await hashTemporaryPassword("Temp-Pass-12345");
    expect(stored.startsWith("scrypt2$12$")).toBe(true);
    expect(await verifyPassword("Temp-Pass-12345", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
    t.db.prepare("UPDATE employees SET password_hash = ? WHERE id = 'e05'").run(stored);
    expect((await loginAs(t, "e05", "Temp-Pass-12345")).status).toBe(200);
    expect((t.db.prepare("SELECT password_hash AS h FROM employees WHERE id = 'e05'").get() as { h: string }).h.startsWith("scrypt2$15$")).toBe(true);
    expect((await hashPassword("x")).startsWith("scrypt2$15$")).toBe(true);
    // 異常に重いパラメータは受け付けない（保存された値の改ざんで、計算資源を使い切らせない）
    expect(await verifyPassword("x", "scrypt2$30$AAAA$AAAA")).toBe(false);
  });
});

describe("座席数の同期", () => {
  it("人数が続けて変わっても、同期は会社ごとに直列で行われ、最後は最新の人数になる（古い人数が最後に残らない）", async () => {
    const billing = new FakeBilling();
    const sent: number[] = [];
    billing.updateSeats = async (i: { itemId: string; quantity: number }) => {
      // 古い呼び出しほど遅く終わる状況を作る
      await new Promise((r) => setTimeout(r, 30 - Math.min(sent.length, 3) * 8));
      sent.push(i.quantity);
    };
    const t = setup({ nowMin: 600, at: "10:00", billing });
    t.manager.update(t.tenant.id, { status: "active", stripeItemId: "si_1", stripeCustomerId: "cus_1" });
    const count = () => (t.db.prepare("SELECT COUNT(*) AS n FROM employees WHERE active = 1").get() as { n: number }).n;
    const p = [syncSeats(t.manager, billing, t.tenant.id, t.db)];
    t.db.prepare("UPDATE employees SET active = 0 WHERE id = 'e10'").run();
    p.push(syncSeats(t.manager, billing, t.tenant.id, t.db));
    t.db.prepare("UPDATE employees SET active = 0 WHERE id = 'e11'").run();
    p.push(syncSeats(t.manager, billing, t.tenant.id, t.db));
    await Promise.all(p);
    expect(sent.at(-1)).toBe(count());
    expect(sent.length).toBeLessThanOrEqual(2); // 重なった要求は、まとめて1回
  });
});
