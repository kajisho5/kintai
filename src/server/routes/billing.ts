import { Hono } from "hono";
import { PLAN } from "../plans";
import type { BillingInfo } from "../../domain";
import { applyBillingEvent } from "../billing";
import { activeCount, ApiError, requireAdmin, type Env } from "../context";
import type { Deps } from "./auth";

/** Stripe からの通知。ログイン不要だが、署名を検証できたものだけを処理する */
export function webhookRoutes({ manager, billing, clockFor }: Deps): Hono<Env> {
  const app = new Hono<Env>();
  app.post("/api/billing/webhook", async (c) => {
    const raw = await c.req.text(); // 署名検証には加工前の本文が必要
    const ev = billing.parseWebhook(raw, c.req.header("stripe-signature"));
    const result = applyBillingEvent(manager, ev, clockFor("Asia/Tokyo").now().ts);
    if (result === "unknown_tenant") console.warn(`Stripe イベント ${ev.id} に対応する会社が見つかりません`);
    return c.json({ received: true, result });
  });
  return app;
}

export function billingRoutes({ manager, billing }: Deps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/api/billing", (c) => {
    requireAdmin(c);
    const t = manager.findById(c.get("tenant").id)!;
    const access = c.get("access");
    const seats = activeCount(c.get("db"));
    const body: BillingInfo = {
      configured: billing.configured,
      state: access.state,
      trialDaysLeft: access.trialDaysLeft,
      trialEndsAt: t.trialEndsAt,
      seatsUsed: seats,
      pricePerSeatJpy: PLAN.pricePerSeatJpy,
      monthlyEstimateJpy: Math.max(1, seats) * PLAN.pricePerSeatJpy,
      emailVerified: !!t.adminEmailVerifiedAt,
      hasSubscription: !!t.stripeSubscriptionId && t.status !== "canceled",
      graceEndsAt: t.status === "past_due" && t.pastDueSince ? t.pastDueSince + PLAN.pastDueGraceDays * 86400_000 : undefined,
    };
    return c.json(body);
  });

  app.post("/api/billing/checkout", async (c) => {
    const admin = requireAdmin(c);
    const t = manager.findById(c.get("tenant").id)!;
    if (t.stripeSubscriptionId && t.status !== "canceled") throw new ApiError(409, "すでにご契約中です。お支払い方法の変更は「請求・お支払いの管理」から行えます");
    if (!t.adminEmailVerifiedAt) throw new ApiError(403, "お申し込みの前に、メールアドレスの確認が必要です。届いた確認メールのリンクを開いてください", "EMAIL_UNVERIFIED");
    const seats = activeCount(c.get("db"));
    if (seats > PLAN.paidSeatLimit) throw new ApiError(409, `${PLAN.paidSeatLimit}名を超える場合は、お問い合わせください`);
    return c.json(await billing.createCheckout({ tenant: t, seats, email: t.adminEmail || admin.email || "" }));
  });

  app.post("/api/billing/portal", async (c) => {
    requireAdmin(c);
    const t = manager.findById(c.get("tenant").id)!;
    if (!t.stripeCustomerId) throw new ApiError(409, "まだお申し込みがありません");
    return c.json(await billing.createPortal({ customerId: t.stripeCustomerId }));
  });

  return app;
}
