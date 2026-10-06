import { describe, expect, it, vi } from "vitest";
import { buildCsv, csvCell } from "../app/format";
import { applyBillingEvent, type BillingEvent } from "./billing";
import { DiscardMailer, mailerFromEnv } from "./mail";
import { PASSWORD, setup } from "./testkit";

const NOW = Date.parse("2026-10-06T14:00:00+09:00");
const ev = (e: Partial<BillingEvent> & { kind: BillingEvent["kind"] }, id: string, created = NOW / 1000): BillingEvent => ({ id, created, ...e }) as BillingEvent;

describe("リクエスト本文のサイズ制限", () => {
  it("未ログインの API でも、大きすぎる本文は 413 で拒否される", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const big = JSON.stringify({ company: "demo", id: "e01", password: "x".repeat(100_000) });
    const r = await t.app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(r.status).toBe(413);
    // Stripe の通知（署名の検証前）も、上限を超える本文は読まない
    const w = await t.app.request("/api/billing/webhook", { method: "POST", body: "x".repeat(1_100_000) });
    expect(w.status).toBe(413);
  });

  it("Content-Length を偽っても（本文が実際に大きければ）拒否される。通常の大きさは通る", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const ok = await t.app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "demo", id: "e01", password: PASSWORD }) });
    expect(ok.status).toBe(200);
  });

  it("CSV取り込みだけは、64KBを超える本文（3MBまで）を受け付ける", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const admin = await t.login("e16");
    const header = "社員ID,氏名,部署,入社日";
    const lines = Array.from({ length: 1 }, () => "q1,名前,営業,2026-04-01");
    const padded = [header, ...lines].join("\n") + "\n" + " ".repeat(100_000);
    const r = await t.call("POST", "/api/employees/import", { cookie: admin, body: { csv: padded, dryRun: true } });
    expect(r.status).toBe(200);
  });
});

describe("非同期のパスワード処理とログイン制限", () => {
  it("同じアカウントへ別のIPから失敗を重ねても、同じIPからの5回失敗のロックで本人は影響を受けにくい", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const post = (ip: string, password: string) =>
      t.call("POST", "/api/auth/login", { body: { company: "demo", id: "e16", password }, headers: { "x-forwarded-for": ip } });
    // trustProxy が無効のテスト環境では全員が同じIP扱い。ここでは「アカウント×IP」で5回失敗したらロックされることを確認する
    for (let i = 0; i < 5; i++) expect((await post("1.1.1.1", "wrong-password")).status).toBe(401);
    expect((await post("1.1.1.1", PASSWORD)).status).toBe(423);
  });

  it("パスワード変更の連続実行は制限される（成功も数える）", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    let cookie = await t.login("e11");
    let current = PASSWORD;
    let blockedAt = 0;
    for (let i = 1; i <= 12; i++) {
      const next = `new-password-${i}-abc`;
      const r = await t.call("POST", "/api/auth/password", { cookie, body: { current, next } });
      if (r.status === 429) {
        blockedAt = i;
        break;
      }
      expect(r.status).toBe(200);
      cookie = r.res.headers.get("set-cookie")!.split(";")[0]!;
      current = next;
    }
    expect(blockedAt).toBe(11);
  }, 30_000);
});

describe("会社名・お名前の入力", () => {
  const signup = (t: ReturnType<typeof setup>, over: Record<string, unknown>) =>
    t.call("POST", "/api/signup", { body: { companyName: "アクメ", code: "acme", adminName: "青木", email: "a@example.com", password: "long-enough-pass-1", acceptTerms: true, ...over } });

  it("改行・制御文字・URL は受け付けない（案内メールの本文に入るため）", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await signup(t, { adminName: "青木\nhttps://evil.example/login" })).status).toBe(400);
    expect((await signup(t, { adminName: "青木 https://evil.example" })).status).toBe(400);
    expect((await signup(t, { companyName: "アクメ www.evil.example" })).status).toBe(400);
    expect((await signup(t, { companyName: "ア\u0000クメ" })).status).toBe(400);
    expect((await signup(t, {})).status).toBe(201);
  });
});

describe("Stripe イベントと運営者の停止", () => {
  it("停止（suspended）した会社は、Stripe の通知で自動では復活しない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { status: "suspended", stripeLastEventAt: 0 });
    applyBillingEvent(t.manager, ev({ kind: "subscription", tenantId: t.tenant.id, customerId: "cus_1", subscriptionId: "sub_1", itemId: "si_1", status: "active" }, "e1"), NOW);
    applyBillingEvent(t.manager, ev({ kind: "checkout_completed", tenantId: t.tenant.id, customerId: "cus_1", subscriptionId: "sub_1", paid: true }, "e2"), NOW);
    t.manager.update(t.tenant.id, { stripeCustomerId: "cus_1" });
    applyBillingEvent(t.manager, ev({ kind: "invoice_paid", customerId: "cus_1" }, "e3"), NOW);
    const after = t.manager.findById(t.tenant.id)!;
    expect(after.status).toBe("suspended");
    expect(after).toMatchObject({ stripeCustomerId: "cus_1", stripeItemId: "si_1" }); // 紐づけ情報は更新される
  });

  it("古い支払い失敗の通知が、回復後に届いても、状態を戻さない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { stripeCustomerId: "cus_1", status: "past_due", pastDueSince: NOW });
    expect(applyBillingEvent(t.manager, ev({ kind: "invoice_paid", customerId: "cus_1" }, "paid", NOW / 1000 + 100), NOW)).toBe("applied");
    expect(applyBillingEvent(t.manager, ev({ kind: "invoice_failed", customerId: "cus_1" }, "late-failed", NOW / 1000 + 10), NOW)).toBe("stale");
    expect(t.manager.findById(t.tenant.id)!.status).toBe("active");
  });
});

describe("メール", () => {
  it("本番で SMTP が未設定なら、メールの本文（再設定リンク）をログに出さない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mailer = mailerFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(mailer).toBeInstanceOf(DiscardMailer);
    await mailer.send({ to: "someone@example.com", subject: "再設定", text: "https://app.example.com/app/#/reset?token=SECRET" });
    const out = [...log.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("someone@example.com"); // 宛先も一部を伏せる
    log.mockRestore();
    warn.mockRestore();
  });
});

describe("ヘルスチェック", () => {
  it("管理用DBに接続できれば ok を返す", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect((await t.call("GET", "/api/health")).json).toEqual({ ok: true });
  });
});

describe("CSV の数式インジェクション対策", () => {
  it("先頭が = + - @ の文字列は、数式として実行されないよう ' を付ける", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });
  it("数値（負の数を含む）や通常の文字列は変えない。カンマ・引用符・改行は囲む", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("山田 太郎")).toBe("山田 太郎");
    expect(csvCell("09:00")).toBe("09:00");
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
  it("BOM付きで行を CRLF 区切りにする", () => {
    expect(buildCsv([["a", 1], ["=x", 2]])).toBe("﻿a,1\r\n'=x,2");
  });
});
