import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, type Db } from "./db";
import { PLAN } from "./plans";
import { syncNationalHolidays } from "./holidays";

export type TenantStatus = "trialing" | "active" | "past_due" | "canceled" | "suspended";

export interface Tenant {
  id: string;
  /** ログインに使う企業ID */
  code: string;
  name: string;
  tz: string;
  status: TenantStatus;
  trialEndsAt: number;
  adminEmail: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt: number;
}

interface TenantRow {
  id: string;
  code: string;
  name: string;
  tz: string;
  status: TenantStatus;
  trial_ends_at: number;
  admin_email: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: number;
}

const CONTROL_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','suspended')),
  trial_ends_at INTEGER NOT NULL,
  admin_email TEXT NOT NULL,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  terms_version TEXT,
  terms_accepted_at INTEGER,
  created_at INTEGER NOT NULL
);
`;

/** 企業IDに使えない語（URL・運用で使うもの） */
const RESERVED = new Set(["admin", "api", "app", "www", "login", "signup", "support", "help", "status", "billing", "static", "assets", "demo", "test", "root", "system", "kintai"]);

export const CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function validateCode(code: string): string | undefined {
  if (!CODE_RE.test(code)) return "企業IDは半角英小文字・数字・ハイフンの3〜32文字で入力してください（先頭と末尾は英数字）";
  if (RESERVED.has(code)) return "この企業IDは使えません";
  return undefined;
}

const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  code: r.code,
  name: r.name,
  tz: r.tz,
  status: r.status,
  trialEndsAt: r.trial_ends_at,
  adminEmail: r.admin_email,
  stripeCustomerId: r.stripe_customer_id ?? undefined,
  stripeSubscriptionId: r.stripe_subscription_id ?? undefined,
  createdAt: r.created_at,
});

/**
 * 顧客（テナント）の管理。顧客ごとに別の SQLite ファイルを持つため、
 * リクエストが扱う DB ハンドルは常に 1 社分だけで、他社のデータに触れる経路がない。
 */
export class TenantManager {
  private control: DatabaseSync;
  private open = new Map<string, { db: Db; used: number }>();

  /**
   * @param tenantDir テナント DB を置くディレクトリ。":memory:" ならメモリ上（テスト用・閉じない）
   */
  constructor(controlFile: string, private readonly tenantDir: string, private readonly maxOpen = 500) {
    if (tenantDir !== ":memory:") mkdirSync(tenantDir, { recursive: true });
    this.control = new DatabaseSync(controlFile);
    this.control.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.control.exec(CONTROL_SQL);
  }

  findByCode(code: string): Tenant | undefined {
    const r = this.control.prepare("SELECT * FROM tenants WHERE code = ?").get(code) as unknown as TenantRow | undefined;
    return r ? toTenant(r) : undefined;
  }

  findById(id: string): Tenant | undefined {
    const r = this.control.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as unknown as TenantRow | undefined;
    return r ? toTenant(r) : undefined;
  }

  findByStripeCustomer(customerId: string): Tenant | undefined {
    const r = this.control.prepare("SELECT * FROM tenants WHERE stripe_customer_id = ?").get(customerId) as unknown as TenantRow | undefined;
    return r ? toTenant(r) : undefined;
  }

  list(): Tenant[] {
    return (this.control.prepare("SELECT * FROM tenants ORDER BY created_at").all() as unknown as TenantRow[]).map(toTenant);
  }

  /** 会社を作る。企業IDの重複は例外（UNIQUE 制約）になる */
  create(input: { code: string; name: string; adminEmail: string; tz?: string; nowMs: number; termsVersion?: string; trialDays?: number }): Tenant {
    const id = randomBytes(8).toString("hex");
    const trialDays = input.trialDays ?? PLAN.trialDays;
    this.control
      .prepare(
        "INSERT INTO tenants (id, code, name, tz, status, trial_ends_at, admin_email, terms_version, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, 'trialing', ?, ?, ?, ?, ?)",
      )
      .run(id, input.code, input.name, input.tz ?? "Asia/Tokyo", input.nowMs + trialDays * 86400_000, input.adminEmail, input.termsVersion ?? null, input.termsVersion ? input.nowMs : null, input.nowMs);
    return this.findById(id)!;
  }

  update(id: string, patch: Partial<Pick<Tenant, "name" | "status" | "trialEndsAt" | "stripeCustomerId" | "stripeSubscriptionId" | "adminEmail">>): void {
    const cols: Record<string, string> = {
      name: "name",
      status: "status",
      trialEndsAt: "trial_ends_at",
      stripeCustomerId: "stripe_customer_id",
      stripeSubscriptionId: "stripe_subscription_id",
      adminEmail: "admin_email",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof typeof cols, string | number][];
    if (!entries.length) return;
    this.control
      .prepare(`UPDATE tenants SET ${entries.map(([k]) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id);
  }

  delete(id: string): void {
    this.control.prepare("DELETE FROM tenants WHERE id = ?").run(id);
  }

  /** テナントの DB。初回に開くとき、マイグレーションと祝日データの同期を行う */
  db(tenantId: string): Db {
    const hit = this.open.get(tenantId);
    if (hit) {
      hit.used = Date.now();
      return hit.db;
    }
    const file = this.tenantDir === ":memory:" ? ":memory:" : join(this.tenantDir, `${tenantId}.db`);
    const db = openDb(file);
    syncNationalHolidays(db);
    this.open.set(tenantId, { db, used: Date.now() });
    this.evict();
    return db;
  }

  private evict(): void {
    if (this.tenantDir === ":memory:" || this.open.size <= this.maxOpen) return;
    const now = Date.now();
    const idle = [...this.open.entries()].filter(([, v]) => now - v.used > 60_000).sort((a, b) => a[1].used - b[1].used);
    for (const [id, v] of idle.slice(0, this.open.size - this.maxOpen)) {
      v.db.close();
      this.open.delete(id);
    }
  }

  close(): void {
    for (const v of this.open.values()) v.db.close();
    this.open.clear();
    this.control.close();
  }
}
