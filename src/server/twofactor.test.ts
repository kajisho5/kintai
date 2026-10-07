import { beforeEach, describe, expect, it } from "vitest";
import type { MeResponse, TwoFactorSetup } from "../domain";
import { PASSWORD, setup } from "./testkit";
import { base32Decode, base32Encode, newRecoveryCodes, normalizeRecovery, openSecret, sealSecret, stepOf, totpAt, verifyTotp } from "./totp";

describe("TOTP（RFC 6238）", () => {
  const rfc = base32Encode(Buffer.from("12345678901234567890"));
  it("RFC 6238 のテストベクタと一致する（SHA-1・6桁）", () => {
    expect(totpAt(rfc, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(rfc, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(rfc, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpAt(rfc, Math.floor(20000000000 / 30))).toBe("353130");
  });

  it("Base32 の変換が往復できる。不正な文字は拒否する", () => {
    const b = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(() => base32Decode("AB1!")).toThrow();
  });

  it("前後1ステップのずれを許し、それ以外・桁数の違い・使用済みのステップは拒否する", () => {
    const t = 1_000_000_000_000;
    const step = stepOf(t);
    expect(verifyTotp(rfc, totpAt(rfc, step), t)).toBe(step);
    expect(verifyTotp(rfc, totpAt(rfc, step - 1), t)).toBe(step - 1);
    expect(verifyTotp(rfc, totpAt(rfc, step + 1), t)).toBe(step + 1);
    expect(verifyTotp(rfc, totpAt(rfc, step + 2), t)).toBeUndefined();
    expect(verifyTotp(rfc, totpAt(rfc, step - 2), t)).toBeUndefined();
    expect(verifyTotp(rfc, "12345", t)).toBeUndefined();
    expect(verifyTotp(rfc, "abcdef", t)).toBeUndefined();
    expect(verifyTotp(rfc, totpAt(rfc, step), t, step)).toBeUndefined(); // 使用済み
    expect(verifyTotp(rfc, ` ${totpAt(rfc, step).slice(0, 3)} ${totpAt(rfc, step).slice(3)} `, t)).toBe(step); // 空白は無視
  });

  it("秘密鍵は、SECRET_KEY があれば暗号化して保存し、鍵が違えば読み出せない。回復コードは読みやすい形式", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", "key-1");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(openSecret(sealed, "key-1")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => openSecret(sealed, "key-2")).toThrow();
    expect(() => openSecret(sealed, undefined)).toThrow();
    expect(openSecret(sealSecret("ABC", undefined), undefined)).toBe("ABC");
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(8);
    expect(codes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(normalizeRecovery("abcde-fghjk")).toBe("ABCDEFGHJK");
  });
});

describe("二段階認証（API）", () => {
  let t: ReturnType<typeof setup>;
  let admin: string;
  const codeNow = (secret: string, offset = 0) => totpAt(secret, stepOf(t.clock.now().ts) + offset);
  const login = (id: string, code?: string, password = PASSWORD) => t.call("POST", "/api/auth/login", { body: { company: "demo", id, password, ...(code ? { code } : {}) } });
  const enable = async (cookie: string): Promise<{ secret: string; recovery: string[] }> => {
    const s = (await t.call("POST", "/api/auth/2fa/setup", { cookie, body: { password: PASSWORD } })).json as TwoFactorSetup;
    const r = await t.call("POST", "/api/auth/2fa/enable", { cookie, body: { code: codeNow(s.secret) } });
    expect(r.status).toBe(200);
    return { secret: s.secret, recovery: r.json.recoveryCodes };
  };

  beforeEach(async () => {
    t = setup({ nowMin: 840, at: "14:00" });
    admin = await t.login("e16");
  });

  it("設定: 秘密鍵とURIが発行され、確認コードが合えば有効になり、回復コードが一度だけ表示される。未設定→設定済みの状態が分かる", async () => {
    expect((await t.call("GET", "/api/auth/2fa", { cookie: admin })).json).toEqual({ enabled: false, required: false });
    const s = (await t.call("POST", "/api/auth/2fa/setup", { cookie: admin, body: { password: PASSWORD } })).json as TwoFactorSetup;
    expect(s.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(s.uri).toContain(`secret=${s.secret}`);
    expect(s.uri).toContain("otpauth://totp/");
    expect(decodeURIComponent(s.uri)).toContain("demo/e16");
    const wrong = await t.call("POST", "/api/auth/2fa/enable", { cookie: admin, body: { code: "000000" } });
    expect(wrong.status).toBe(400);
    expect(((await t.call("GET", "/api/auth/2fa", { cookie: admin })).json as { enabled: boolean }).enabled).toBe(false);
    const ok = await t.call("POST", "/api/auth/2fa/enable", { cookie: admin, body: { code: codeNow(s.secret) } });
    expect(ok.status).toBe(200);
    expect(ok.json.recoveryCodes).toHaveLength(8);
    expect((await t.call("GET", "/api/auth/2fa", { cookie: admin })).json.enabled).toBe(true);
    expect((await t.call("POST", "/api/auth/2fa/setup", { cookie: admin, body: { password: PASSWORD } })).status).toBe(409);
    // 保存されているのは、暗号化された秘密鍵と回復コードのハッシュだけ
    const row = t.db.prepare("SELECT totp_secret AS s, totp_recovery AS r FROM employees WHERE id = 'e16'").get() as { s: string; r: string };
    expect(row.s).toMatch(/^(plain|v1):/);
    expect(row.r).not.toContain(ok.json.recoveryCodes[0]);
    const me = (await t.call("GET", "/api/me", { cookie: admin })).json as MeResponse;
    expect(me.twoFactor).toEqual({ enabled: true, mustSetup: false });
  });

  it("ログイン: パスワードのあとに確認コードが要る。コードなしでは入れず、間違いは拒否、合えば入れる", async () => {
    const { secret } = await enable(admin);
    const noCode = await login("e16");
    expect(noCode.json).toEqual({ ok: false, totpRequired: true });
    expect(noCode.res.headers.get("set-cookie")).toBeNull();
    expect((await login("e16", "123456")).status).toBe(401);
    expect((await login("e16", undefined, "wrong-password-x")).status).toBe(401); // パスワードが違えば、二段階目には進まない
    t.clock.set("2026-10-06", "14:01"); // 次のステップ（使用済みのコードは使えない）
    const ok = await login("e16", codeNow(secret));
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get("set-cookie")).toContain("sid=");
    // 二段階認証のない社員は、これまでどおり
    expect((await login("e01")).status).toBe(200);
  });

  it("同じコードは再利用できない（盗み見られたコードでは、もう一度入れない）", async () => {
    const { secret } = await enable(admin); // 設定の確認で、このステップのコードは使用済み
    t.clock.set("2026-10-06", "14:01");
    const code = codeNow(secret);
    expect((await login("e16", code)).status).toBe(200);
    expect((await login("e16", code)).status).toBe(401);
    // 同時に同じコードで確認されても、通るのは1回だけ
    t.clock.set("2026-10-06", "14:02");
    const c2 = codeNow(secret);
    const r = await Promise.all([login("e16", c2), login("e16", c2), login("e16", c2)]);
    expect(r.filter((x) => x.status === 200)).toHaveLength(1);
  });

  it("確認コードを5回間違えると、5分ロックされる（正しいコードでも入れない）。5分後に解除される", async () => {
    const { secret } = await enable(admin);
    t.clock.set("2026-10-06", "14:01");
    for (let i = 0; i < 5; i++) expect((await login("e16", "000000")).status).toBe(401);
    expect((await login("e16", codeNow(secret))).status).toBe(423);
    t.clock.set("2026-10-06", "14:07");
    expect((await login("e16", codeNow(secret))).status).toBe(200);
  });

  it("回復コードで入れる（1回限り）。使った回数が監査ログに残り、残りが減る", async () => {
    const { recovery } = await enable(admin);
    t.clock.set("2026-10-06", "14:01");
    expect((await login("e16", recovery[0]!.toLowerCase())).status).toBe(200); // 大文字小文字は区別しない
    expect((await login("e16", recovery[0]!)).status).toBe(401);
    expect((await login("e16", recovery[1]!.replace("-", " "))).status).toBe(200);
    const log = t.db.prepare("SELECT detail FROM audit_log WHERE action = 'totp_recovery_used' ORDER BY id").all() as { detail: string }[];
    expect(log.map((l) => JSON.parse(l.detail).remaining)).toEqual([7, 6]);
  });

  it("解除: パスワードと確認コードが要る。会社が必須にしている管理者は解除できない", async () => {
    const { secret } = await enable(admin);
    t.clock.set("2026-10-06", "14:01");
    const dis = (cookie: string, body: Record<string, string>) => t.call("POST", "/api/auth/2fa/disable", { cookie, body });
    const c = (await login("e16", codeNow(secret))).res.headers.get("set-cookie")!.split(";")[0]!;
    t.clock.set("2026-10-06", "14:02");
    expect((await dis(c, { password: "wrong-password-x", code: codeNow(secret) })).status).toBe(400);
    expect((await dis(c, { password: PASSWORD, code: "000000" })).status).toBe(400);
    // 必須にすると、解除できない
    await t.call("PATCH", "/api/settings", { cookie: c, body: { require2fa: true } });
    expect((await dis(c, { password: PASSWORD, code: codeNow(secret) })).status).toBe(409);
    await t.call("PATCH", "/api/settings", { cookie: c, body: { require2fa: false } });
    t.clock.set("2026-10-06", "14:03");
    expect((await dis(c, { password: PASSWORD, code: codeNow(secret) })).status).toBe(200);
    expect((await login("e16")).status).toBe(200); // 解除後は、パスワードだけで入れる
  });

  it("管理者に必須にすると、未設定の管理者は、設定が済むまで他の操作ができない。一般の社員には影響しない", async () => {
    await t.call("PATCH", "/api/settings", { cookie: admin, body: { require2fa: true } });
    const me = (await t.call("GET", "/api/me", { cookie: admin })).json as MeResponse;
    expect(me.twoFactor).toEqual({ enabled: false, mustSetup: true });
    const blocked = await t.call("GET", "/api/employees", { cookie: admin });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("TWO_FACTOR_REQUIRED");
    expect((await t.call("GET", "/api/dashboard", { cookie: admin })).status).toBe(403);
    expect((await t.call("GET", "/api/settings", { cookie: admin })).status).toBe(403); // 設定の画面も、設定のあとに
    await enable(admin);
    expect((await t.call("GET", "/api/employees", { cookie: admin })).status).toBe(200);
    expect(((await t.call("GET", "/api/auth/2fa", { cookie: admin })).json as { required: boolean }).required).toBe(true);
    const emp = await t.login("e01");
    expect((await t.call("GET", "/api/punch/today", { cookie: emp })).status).toBe(200);
    expect(((await t.call("GET", "/api/me", { cookie: emp })).json as MeResponse).twoFactor.mustSetup).toBe(false);
  });

  it("管理者が、ほかの社員の二段階認証を解除できる（ログイン中の端末はログアウトされ、記録が残る）。自分の分・設定していない社員・一般の社員は不可", async () => {
    const e01 = await t.login("e01");
    await enable(e01);
    expect((await t.call("POST", "/api/employees/e01/2fa-reset", { cookie: e01 })).status).toBe(403);
    expect(((await t.call("GET", "/api/employees", { cookie: admin })).json.rows as { id: string; hasTotp: boolean }[]).find((r) => r.id === "e01")!.hasTotp).toBe(true);
    expect((await t.call("POST", "/api/employees/e16/2fa-reset", { cookie: admin })).status).toBe(400);
    expect((await t.call("POST", "/api/employees/e02/2fa-reset", { cookie: admin })).status).toBe(409);
    expect((await t.call("POST", "/api/employees/e01/2fa-reset", { cookie: admin })).status).toBe(200);
    expect((await t.call("GET", "/api/me", { cookie: e01 })).status).toBe(401);
    expect((await login("e01")).status).toBe(200);
    const log = t.db.prepare("SELECT actor, detail FROM audit_log WHERE action = 'totp_reset'").all() as { actor: string; detail: string }[];
    expect(log).toEqual([{ actor: "e16", detail: JSON.stringify({ id: "e01" }) }]);
  });
});
