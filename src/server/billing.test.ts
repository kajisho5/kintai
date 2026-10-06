import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import type { BillingInfo, EmployeesResponse } from "../domain";
import { applyBillingEvent, StripeBilling, type BillingEvent } from "./billing";
import { runJobs } from "./jobs";
import { accessOf, PLAN } from "./plans";
import { FakeBilling, setup } from "./testkit";

const NOW = Date.parse("2026-10-06T14:00:00+09:00");
const flush = () => new Promise((r) => setTimeout(r, 0));
const ev = (over: Partial<BillingEvent> & { kind: BillingEvent["kind"] }, id = `evt_${Math.random()}`, created = NOW / 1000): BillingEvent => ({ id, created, ...over }) as BillingEvent;

describe("Stripe のイベント → 契約状態", () => {
  it("決済が完了すると有料契約（active）になり、Stripe の顧客・契約が紐づく", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: NOW + 86400_000 });
    const r = applyBillingEvent(t.manager, ev({ kind: "checkout_completed", tenantId: t.tenant.id, customerId: "cus_1", subscriptionId: "sub_1", paid: true }), NOW);
    expect(r).toBe("applied");
    expect(t.manager.findById(t.tenant.id)).toMatchObject({ status: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
  });

  it("未払いの完了通知では契約状態を変えない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: NOW + 86400_000 });
    expect(applyBillingEvent(t.manager, ev({ kind: "checkout_completed", tenantId: t.tenant.id, customerId: "cus_1", paid: false }), NOW)).toBe("ignored");
    expect(t.manager.findById(t.tenant.id)!.status).toBe("trialing");
  });

  it("同じイベントが再配信されても二重に処理しない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const e = ev({ kind: "checkout_completed", tenantId: t.tenant.id, customerId: "cus_1", subscriptionId: "sub_1", paid: true }, "evt_dup");
    expect(applyBillingEvent(t.manager, e, NOW)).toBe("applied");
    expect(applyBillingEvent(t.manager, e, NOW)).toBe("duplicate");
  });

  it("支払い遅延 → 回復 → 解約の流れ。支払い遅延の起点は最初の1回だけ記録する", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const id = t.tenant.id;
    const sub = (status: string, at: number) => applyBillingEvent(t.manager, ev({ kind: "subscription", tenantId: id, customerId: "cus_1", subscriptionId: "sub_1", itemId: "si_1", status }, `e${at}${status}`, at), NOW + at * 1000);
    expect(sub("active", 100)).toBe("applied");
    expect(t.manager.findById(id)).toMatchObject({ status: "active", stripeItemId: "si_1" });
    sub("past_due", 200);
    expect(t.manager.findById(id)).toMatchObject({ status: "past_due", pastDueSince: NOW + 200_000 });
    sub("unpaid", 300);
    expect(t.manager.findById(id)!.pastDueSince).toBe(NOW + 200_000);
    sub("active", 400);
    expect(t.manager.findById(id)).toMatchObject({ status: "active", pastDueSince: undefined });
    sub("canceled", 500);
    expect(t.manager.findById(id)!.status).toBe("canceled");
  });

  it("古いイベントが後から届いても、新しい状態を巻き戻さない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    const id = t.tenant.id;
    const sub = (status: string, created: number, eid: string) => applyBillingEvent(t.manager, ev({ kind: "subscription", tenantId: id, customerId: "cus_1", subscriptionId: "sub_1", status }, eid, created), NOW);
    sub("canceled", 2000, "new");
    expect(sub("active", 1000, "old")).toBe("stale");
    expect(t.manager.findById(id)!.status).toBe("canceled");
  });

  it("支払いが確定していない状態（incomplete）では契約状態を変えない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: NOW + 86400_000 });
    expect(applyBillingEvent(t.manager, ev({ kind: "subscription", tenantId: t.tenant.id, subscriptionId: "sub_1", status: "incomplete" }), NOW)).toBe("ignored");
    expect(t.manager.findById(t.tenant.id)!.status).toBe("trialing");
  });

  it("請求の支払い失敗・成功で、active と past_due を行き来する。解約済みは復活させない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { stripeCustomerId: "cus_1" });
    applyBillingEvent(t.manager, ev({ kind: "invoice_failed", customerId: "cus_1" }), NOW);
    expect(t.manager.findById(t.tenant.id)).toMatchObject({ status: "past_due", pastDueSince: NOW });
    applyBillingEvent(t.manager, ev({ kind: "invoice_paid", customerId: "cus_1" }), NOW);
    expect(t.manager.findById(t.tenant.id)).toMatchObject({ status: "active", pastDueSince: undefined });
    t.manager.update(t.tenant.id, { status: "canceled" });
    expect(applyBillingEvent(t.manager, ev({ kind: "invoice_paid", customerId: "cus_1" }), NOW)).toBe("ignored");
    expect(t.manager.findById(t.tenant.id)!.status).toBe("canceled");
  });

  it("対応する会社がないイベントは記録だけして何も変えない", () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    expect(applyBillingEvent(t.manager, ev({ kind: "invoice_paid", customerId: "cus_unknown" }), NOW)).toBe("unknown_tenant");
  });
});

describe("支払い遅延の猶予", () => {
  it("猶予期間（14日）を過ぎると閲覧のみになる", () => {
    const base = { status: "past_due" as const, trialEndsAt: 0 };
    expect(accessOf({ ...base, pastDueSince: NOW - 13 * 86400_000 }, NOW).writable).toBe(true);
    expect(accessOf({ ...base, pastDueSince: NOW - 15 * 86400_000 }, NOW).writable).toBe(false);
    expect(PLAN.pastDueGraceDays).toBe(14);
  });

  it("API でも、猶予を過ぎると変更が拒否される", async () => {
    const t = setup({ nowMin: -1, at: "09:00" });
    const c = await t.login("e01");
    t.manager.update(t.tenant.id, { status: "past_due", pastDueSince: t.clock.now().ts - 20 * 86400_000 });
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } })).status).toBe(402);
    t.manager.update(t.tenant.id, { pastDueSince: t.clock.now().ts - 2 * 86400_000 });
    expect((await t.call("POST", "/api/punch", { cookie: c, body: { action: "in" } })).status).toBe(200);
  });
});

describe("Webhook（署名の検証つき）", () => {
  const SECRET = "whsec_test_secret";
  const stripe = new Stripe("sk_test_dummy");
  const gw = new StripeBilling({ secretKey: "sk_test_dummy", webhookSecret: SECRET, priceId: "price_1", appUrl: "https://app.example.com" });
  const send = async (t: ReturnType<typeof setup>, payload: string, signature: string | undefined) => {
    const res = await t.app.request("/api/billing/webhook", { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) }, body: payload });
    return { status: res.status, json: await res.json() };
  };
  const checkoutEvent = (tenantId: string, id = "evt_checkout_1") =>
    JSON.stringify({
      id,
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(NOW / 1000),
      data: { object: { id: "cs_1", object: "checkout.session", mode: "subscription", client_reference_id: tenantId, customer: "cus_100", subscription: "sub_100", payment_status: "paid", metadata: { tenantId } } },
    });

  it("正しい署名のイベントだけが契約状態に反映される", async () => {
    const t = setup({ nowMin: 840, at: "14:00", billing: gw });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: NOW + 86400_000 });
    const payload = checkoutEvent(t.tenant.id);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const r = await send(t, payload, sig);
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("applied");
    expect(t.manager.findById(t.tenant.id)).toMatchObject({ status: "active", stripeCustomerId: "cus_100", stripeSubscriptionId: "sub_100" });
    // 再配信は何も起こさない
    expect((await send(t, payload, sig)).json.result).toBe("duplicate");
  });

  it("署名がない・誤っている・本文が改ざんされている場合は拒否し、何も変えない", async () => {
    const t = setup({ nowMin: 840, at: "14:00", billing: gw });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: NOW + 86400_000 });
    const payload = checkoutEvent(t.tenant.id);
    expect((await send(t, payload, undefined)).status).toBe(400);
    expect((await send(t, payload, stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" }))).status).toBe(400);
    const good = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    expect((await send(t, payload.replace("cus_100", "cus_evil"), good)).status).toBe(400);
    expect(t.manager.findById(t.tenant.id)!.status).toBe("trialing");
  });

  it("関係のないイベントは受け取って無視する", async () => {
    const t = setup({ nowMin: 840, at: "14:00", billing: gw });
    const payload = JSON.stringify({ id: "evt_x", object: "event", type: "charge.succeeded", created: 1, data: { object: {} } });
    const r = await send(t, payload, stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }));
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("ignored");
  });

  it("契約の更新イベントから、座席数の更新先（項目ID）を取り込む", async () => {
    const t = setup({ nowMin: 840, at: "14:00", billing: gw });
    const payload = JSON.stringify({
      id: "evt_sub_1",
      object: "event",
      type: "customer.subscription.updated",
      created: Math.floor(NOW / 1000),
      data: { object: { id: "sub_100", object: "subscription", status: "active", customer: "cus_100", metadata: { tenantId: t.tenant.id }, items: { data: [{ id: "si_100" }] } } },
    });
    expect((await send(t, payload, stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }))).status).toBe(200);
    expect(t.manager.findById(t.tenant.id)).toMatchObject({ stripeItemId: "si_100", stripeCustomerId: "cus_100", status: "active" });
  });
});

describe("請求のAPI", () => {
  it("管理者は人数と月額の目安を見られ、一般社員は見られない", async () => {
    const t = setup({ nowMin: 840, at: "14:00", billing: new FakeBilling() });
    expect((await t.call("GET", "/api/billing", { cookie: await t.login("e01") })).status).toBe(403);
    const b = (await t.call("GET", "/api/billing", { cookie: await t.login("e16") })).json as BillingInfo;
    expect(b).toMatchObject({ configured: true, seatsUsed: 18, pricePerSeatJpy: 300, monthlyEstimateJpy: 18 * 300, hasSubscription: false });
  });

  it("申し込み: 現在の在籍人数で決済ページを作る。契約済みなら重複して申し込めない", async () => {
    const billing = new FakeBilling();
    const t = setup({ nowMin: 840, at: "14:00", billing });
    const admin = await t.login("e16");
    const r = await t.call("POST", "/api/billing/checkout", { cookie: admin });
    expect(r.json.url).toBe("https://checkout.example.com/session");
    expect((billing.calls[0]!.arg as { seats: number }).seats).toBe(18);
    t.manager.update(t.tenant.id, { stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    expect((await t.call("POST", "/api/billing/checkout", { cookie: admin })).status).toBe(409);
    expect((await t.call("POST", "/api/billing/portal", { cookie: admin })).json.url).toBe("https://portal.example.com/session");
  });

  it("お支払い管理はまだ申し込みがないと開けない。未設定の環境では申し込みできない", async () => {
    const t = setup({ nowMin: 840, at: "14:00", billing: new FakeBilling() });
    expect((await t.call("POST", "/api/billing/portal", { cookie: await t.login("e16") })).status).toBe(409);
    const off = setup({ nowMin: 840, at: "14:00" });
    const r = await off.call("POST", "/api/billing/checkout", { cookie: await off.login("e16") });
    expect(r.status).toBe(400);
    expect(((await off.call("GET", "/api/billing", { cookie: await off.login("e16") })).json as BillingInfo).configured).toBe(false);
  });

  it("トライアルが終了していても、申し込み画面は使える（変更系の他の操作はできない）", async () => {
    const t = setup({ nowMin: 840, at: "14:00", billing: new FakeBilling() });
    const admin = await t.login("e16");
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: t.clock.now().ts - 1000 });
    expect((await t.call("POST", "/api/billing/checkout", { cookie: admin })).status).toBe(200);
    expect((await t.call("POST", "/api/settings/holidays", { cookie: admin, body: { date: "2026-12-28", name: "x" } })).status).toBe(402);
  });
});

describe("座席数の同期", () => {
  const NEWEMP = { id: "n01", name: "新入", dept: "営業部", kind: "正社員", role: "employee", workDays: [1, 2, 3, 4, 5], baseMin: 480, schedStart: 540, hired: "2026-10-01" };

  it("社員の追加・退職・復職で、契約中の会社の課金数量が更新される", async () => {
    const billing = new FakeBilling();
    const t = setup({ nowMin: 840, at: "14:00", billing });
    t.manager.update(t.tenant.id, { stripeItemId: "si_1", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    const admin = await t.login("e16");
    await t.call("POST", "/api/employees", { cookie: admin, body: NEWEMP });
    await flush();
    expect(billing.seats.get("si_1")).toBe(19);
    await t.call("POST", "/api/employees/n01/deactivate", { cookie: admin });
    await flush();
    expect(billing.seats.get("si_1")).toBe(18);
    await t.call("POST", "/api/employees/n01/reactivate", { cookie: admin });
    await flush();
    expect(billing.seats.get("si_1")).toBe(19);
  });

  it("未契約（トライアル中）の会社では課金に触れない", async () => {
    const billing = new FakeBilling();
    const t = setup({ nowMin: 840, at: "14:00", billing });
    await t.call("POST", "/api/employees", { cookie: await t.login("e16"), body: NEWEMP });
    await flush();
    expect(billing.calls.filter((c) => c.fn === "updateSeats")).toHaveLength(0);
  });

  it("Stripe への反映に失敗しても社員の追加は成功し、未反映の印が付く。ジョブで再同期される", async () => {
    const billing = new FakeBilling();
    const t = setup({ nowMin: 840, at: "14:00", billing });
    t.manager.update(t.tenant.id, { stripeItemId: "si_1", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", status: "active" });
    const admin = await t.login("e16");
    billing.failUpdates = true;
    expect((await t.call("POST", "/api/employees", { cookie: admin, body: NEWEMP })).status).toBe(201);
    await flush();
    expect(t.manager.findById(t.tenant.id)!.seatsDirty).toBe(true);

    billing.failUpdates = false;
    const r = await runJobs({ manager: t.manager, mailer: t.mailer, billing, clockFor: () => t.clock, appUrl: t.appUrl });
    expect(r.seatsSynced).toBe(1);
    expect(billing.seats.get("si_1")).toBe(19);
    expect(t.manager.findById(t.tenant.id)!.seatsDirty).toBe(false);
    expect(((await t.call("GET", "/api/employees", { cookie: admin })).json as EmployeesResponse).seatsUsed).toBe(19);
  });

  it("全社の照合で、Stripe 側の数量のずれを直す", async () => {
    const billing = new FakeBilling();
    const t = setup({ nowMin: 840, at: "14:00", billing });
    t.manager.update(t.tenant.id, { stripeItemId: "si_1", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", status: "active" });
    billing.seats.set("si_1", 5);
    await runJobs({ manager: t.manager, mailer: t.mailer, billing, clockFor: () => t.clock }, { fullSeatReconcile: true });
    expect(billing.seats.get("si_1")).toBe(18);
  });
});

describe("定期ジョブ", () => {
  const deps = (t: ReturnType<typeof setup>) => ({ manager: t.manager, mailer: t.mailer, billing: t.billing, clockFor: () => t.clock, appUrl: t.appUrl });

  it("トライアル終了の3日前になったら、管理者に案内メールを1回だけ送る", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: t.clock.now().ts + 10 * 86400_000 });
    expect((await runJobs(deps(t))).reminders).toBe(0); // まだ10日ある
    t.manager.update(t.tenant.id, { trialEndsAt: t.clock.now().ts + 2 * 86400_000 });
    expect((await runJobs(deps(t))).reminders).toBe(1);
    expect((await runJobs(deps(t))).reminders).toBe(0); // 2回目は送らない
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]!.to).toBe("admin@example.com");
    expect(t.mailer.sent[0]!.text).toContain("あと2日");
    expect(t.mailer.sent[0]!.text).toContain("https://app.example.com/#/billing");
  });

  it("契約済み・期限切れの会社には送らない", async () => {
    const t = setup({ nowMin: 840, at: "14:00" }); // active
    expect((await runJobs(deps(t))).reminders).toBe(0);
    t.manager.update(t.tenant.id, { status: "trialing", trialEndsAt: t.clock.now().ts - 1000 });
    expect((await runJobs(deps(t))).reminders).toBe(0);
  });

  it("期限切れのセッションと使用済みの再設定トークンを削除する", async () => {
    const t = setup({ nowMin: 840, at: "14:00" });
    await t.login("e01");
    t.db.prepare("UPDATE sessions SET expires_at = 1").run();
    expect((await runJobs(deps(t))).cleaned).toBeGreaterThan(0);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
});

