import Stripe from "stripe";
import { ApiError } from "./context";
import type { Tenant, TenantManager } from "./control";

/** Stripe のイベントを、この製品に必要な形に正規化したもの（SDK の型に依存させない） */
export type BillingEvent =
  | { id: string; created: number; kind: "checkout_completed"; tenantId?: string; customerId?: string; subscriptionId?: string; paid: boolean }
  | { id: string; created: number; kind: "subscription"; tenantId?: string; customerId?: string; subscriptionId: string; itemId?: string; status: string }
  | { id: string; created: number; kind: "invoice_paid" | "invoice_failed"; customerId?: string }
  | { id: string; created: number; kind: "ignored" };

export interface BillingGateway {
  /** 設定済みか。false なら申し込みは受け付けない */
  readonly configured: boolean;
  createCheckout(input: { tenant: Tenant; seats: number; email: string }): Promise<{ url: string }>;
  createPortal(input: { customerId: string }): Promise<{ url: string }>;
  /** 契約中の人数（課金数量）を更新する。日割りは Stripe に任せる */
  updateSeats(input: { itemId: string; quantity: number }): Promise<void>;
  /** 現在 Stripe 側に登録されている数量 */
  getSeats(input: { itemId: string }): Promise<number>;
  /** 署名を検証してイベントを返す。不正なら例外 */
  parseWebhook(rawBody: string, signature: string | undefined): BillingEvent;
}

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  /** 決済後の戻り先などに使う、この製品の公開URL（例: https://app.example.com） */
  appUrl: string;
  /** Stripe Tax で消費税を自動計算する（Stripe 側の設定が必要） */
  automaticTax?: boolean;
}

export class DisabledBilling implements BillingGateway {
  readonly configured = false;
  private off(): never {
    throw new ApiError(400, "お申し込みは現在準備中です。お手数ですが、お問い合わせください");
  }
  createCheckout(): Promise<{ url: string }> {
    return this.off();
  }
  createPortal(): Promise<{ url: string }> {
    return this.off();
  }
  updateSeats(): Promise<void> {
    return this.off();
  }
  getSeats(): Promise<number> {
    return this.off();
  }
  parseWebhook(): BillingEvent {
    return this.off();
  }
}

const idOf = (v: string | { id: string } | null | undefined): string | undefined => (typeof v === "string" ? v : (v?.id ?? undefined));

export class StripeBilling implements BillingGateway {
  readonly configured = true;
  private stripe: Stripe;
  constructor(private readonly cfg: BillingConfig) {
    this.stripe = new Stripe(cfg.secretKey);
  }

  async createCheckout({ tenant, seats, email }: { tenant: Tenant; seats: number; email: string }): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: this.cfg.priceId, quantity: Math.max(1, seats) }],
      client_reference_id: tenant.id,
      metadata: { tenantId: tenant.id },
      subscription_data: { metadata: { tenantId: tenant.id } },
      ...(tenant.stripeCustomerId ? { customer: tenant.stripeCustomerId, customer_update: { name: "auto" as const, address: "auto" as const } } : { customer_email: email }),
      locale: "ja",
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      ...(this.cfg.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      success_url: `${this.cfg.appUrl}/#/billing?checkout=success`,
      cancel_url: `${this.cfg.appUrl}/#/billing?checkout=cancel`,
    });
    if (!session.url) throw new ApiError(400, "決済ページを作成できませんでした。しばらくしてからお試しください");
    return { url: session.url };
  }

  async createPortal({ customerId }: { customerId: string }): Promise<{ url: string }> {
    const s = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${this.cfg.appUrl}/#/billing` });
    return { url: s.url };
  }

  async updateSeats({ itemId, quantity }: { itemId: string; quantity: number }): Promise<void> {
    await this.stripe.subscriptionItems.update(itemId, { quantity: Math.max(1, quantity), proration_behavior: "create_prorations" });
  }

  async getSeats({ itemId }: { itemId: string }): Promise<number> {
    const item = await this.stripe.subscriptionItems.retrieve(itemId);
    return item.quantity ?? 0;
  }

  parseWebhook(rawBody: string, signature: string | undefined): BillingEvent {
    if (!signature) throw new ApiError(400, "署名がありません");
    let e: Stripe.Event;
    try {
      e = this.stripe.webhooks.constructEvent(rawBody, signature, this.cfg.webhookSecret);
    } catch {
      throw new ApiError(400, "署名を検証できません");
    }
    return normalizeStripeEvent(e);
  }
}

export function normalizeStripeEvent(e: Stripe.Event): BillingEvent {
  const base = { id: e.id, created: e.created };
  switch (e.type) {
    case "checkout.session.completed": {
      const s = e.data.object;
      if (s.mode !== "subscription") return { ...base, kind: "ignored" };
      return {
        ...base,
        kind: "checkout_completed",
        tenantId: s.client_reference_id ?? s.metadata?.tenantId ?? undefined,
        customerId: idOf(s.customer),
        subscriptionId: idOf(s.subscription),
        paid: s.payment_status === "paid" || s.payment_status === "no_payment_required",
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const s = e.data.object;
      return {
        ...base,
        kind: "subscription",
        tenantId: s.metadata?.tenantId,
        customerId: idOf(s.customer),
        subscriptionId: s.id,
        itemId: s.items?.data?.[0]?.id,
        status: e.type === "customer.subscription.deleted" ? "canceled" : s.status,
      };
    }
    case "invoice.paid":
      return { ...base, kind: "invoice_paid", customerId: idOf(e.data.object.customer) };
    case "invoice.payment_failed":
      return { ...base, kind: "invoice_failed", customerId: idOf(e.data.object.customer) };
    default:
      return { ...base, kind: "ignored" };
  }
}

export function billingFromEnv(env: NodeJS.ProcessEnv): BillingGateway {
  const { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_PRICE_ID: priceId, APP_URL: appUrl } = env;
  if (!secretKey || !webhookSecret || !priceId || !appUrl) {
    if (secretKey || webhookSecret || priceId) console.warn("警告: 課金の設定が不足しています（STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_ID / APP_URL がすべて必要）。課金機能は無効です");
    return new DisabledBilling();
  }
  return new StripeBilling({ secretKey, webhookSecret, priceId, appUrl: appUrl.replace(/\/$/, ""), automaticTax: env.STRIPE_AUTOMATIC_TAX === "1" });
}

// ---------------------------------------------------------------- イベントの反映

export type ApplyResult = "applied" | "duplicate" | "ignored" | "stale" | "unknown_tenant";

/** Stripe の状態を契約状態に写す。同じイベントの再配信・古いイベントの逆戻りでは何も変えない */
export function applyBillingEvent(manager: TenantManager, ev: BillingEvent, nowMs: number): ApplyResult {
  if (ev.kind === "ignored") return "ignored";
  if (!manager.recordStripeEvent(ev.id, ev.kind, nowMs)) return "duplicate";
  try {
    const tenant = (("tenantId" in ev && ev.tenantId ? manager.findById(ev.tenantId) : undefined) ?? (ev.customerId ? manager.findByStripeCustomer(ev.customerId) : undefined)) as Tenant | undefined;
    if (!tenant) return "unknown_tenant";
    const at = ev.created * 1000;

    switch (ev.kind) {
      case "checkout_completed": {
        if (!ev.paid) return "ignored";
        manager.update(tenant.id, { stripeCustomerId: ev.customerId, stripeSubscriptionId: ev.subscriptionId, status: "active" });
        manager.clearPastDue(tenant.id);
        return "applied";
      }
      case "subscription": {
        if (at < tenant.stripeLastEventAt) return "stale";
        const link = { stripeCustomerId: ev.customerId, stripeSubscriptionId: ev.subscriptionId, stripeItemId: ev.itemId, stripeLastEventAt: at };
        if (ev.status === "active" || ev.status === "trialing") {
          manager.update(tenant.id, { ...link, status: "active" });
          manager.clearPastDue(tenant.id);
        } else if (ev.status === "past_due" || ev.status === "unpaid") {
          manager.update(tenant.id, { ...link, status: "past_due", pastDueSince: tenant.pastDueSince ?? nowMs });
        } else if (ev.status === "canceled") {
          manager.update(tenant.id, { ...link, status: "canceled" });
        } else {
          // incomplete など、まだ支払いが確定していない状態は契約状態を変えない
          manager.update(tenant.id, { stripeItemId: ev.itemId, stripeLastEventAt: tenant.stripeLastEventAt });
          return "ignored";
        }
        return "applied";
      }
      case "invoice_paid": {
        if (tenant.status !== "past_due") return "ignored";
        manager.update(tenant.id, { status: "active" });
        manager.clearPastDue(tenant.id);
        return "applied";
      }
      case "invoice_failed": {
        if (tenant.status !== "active") return "ignored";
        manager.update(tenant.id, { status: "past_due", pastDueSince: nowMs });
        return "applied";
      }
    }
  } catch (e) {
    manager.forgetStripeEvent(ev.id); // 失敗したら再配信で処理し直せるようにする
    throw e;
  }
}
