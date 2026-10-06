import { expect } from "vitest";
import { createApp } from "./app";
import { fixedClock } from "./clock";
import type { BillingGateway } from "./billing";
import { DisabledBilling } from "./billing";
import { TenantManager } from "./control";
import { MemoryMailer } from "./mail";
import { seedDemo } from "./seed";

export const PASSWORD = "test-password-1";
export const TODAY = "2026-10-06"; // 火曜

/** メモリ上の管理用DB・テナントDBと固定時計で、アプリ一式を組み立てる（テスト用） */
/** 呼び出しを記録するだけの課金（Stripe に接続しない） */
export class FakeBilling implements BillingGateway {
  readonly configured = true;
  calls: { fn: string; arg: unknown }[] = [];
  failUpdates = false;
  seats = new Map<string, number>();
  async createCheckout(input: { seats: number }) {
    this.calls.push({ fn: "createCheckout", arg: input });
    return { url: "https://checkout.example.com/session" };
  }
  async createPortal(input: { customerId: string }) {
    this.calls.push({ fn: "createPortal", arg: input });
    return { url: "https://portal.example.com/session" };
  }
  async updateSeats(input: { itemId: string; quantity: number }) {
    this.calls.push({ fn: "updateSeats", arg: input });
    if (this.failUpdates) throw new Error("stripe down");
    this.seats.set(input.itemId, input.quantity);
  }
  async getSeats(input: { itemId: string }) {
    return this.seats.get(input.itemId) ?? 0;
  }
  parseWebhook(): never {
    throw new Error("FakeBilling は Webhook を扱いません");
  }
}

export const APP_URL = "https://app.example.com";

export function setup(opts: { nowMin: number; at: string; seedDemoCompany?: boolean; billing?: BillingGateway; appUrl?: string | null }) {
  const manager = new TenantManager(":memory:", ":memory:");
  const clock = fixedClock(TODAY, opts.at);
  const mailer = new MemoryMailer();
  const billing = opts.billing ?? new DisabledBilling();
  const appUrl = opts.appUrl === null ? undefined : (opts.appUrl ?? APP_URL);
  const app = createApp({ manager, clockFor: () => clock, config: { secureCookie: false, sessionHours: 12 }, mailer, billing, appUrl });

  const tenant = manager.create({ code: "demo", name: "デモ商事株式会社", adminEmail: "admin@example.com", nowMs: clock.now().ts });
  manager.update(tenant.id, { status: "active" });
  const db = manager.db(tenant.id);
  if (opts.seedDemoCompany !== false) seedDemo(db, { today: TODAY, nowMin: opts.nowMin, password: PASSWORD });

  const call = async (method: string, path: string, opt: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(opt.headers ?? {}) };
    if (opt.cookie) headers.cookie = opt.cookie;
    if (opt.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, res };
  };
  const login = async (id: string, password = PASSWORD, company = "demo"): Promise<string> => {
    const r = await call("POST", "/api/auth/login", { body: { company, id, password } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.res.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { manager, tenant, db, clock, app, call, login, mailer, billing, appUrl };
}
