import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, type Db } from "./db";
import { migrate } from "./migrations";
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
  /** 人数課金の対象になっているサブスクリプション項目（座席数の更新に使う） */
  stripeItemId?: string;
  /** 支払い遅延になった時刻（猶予期間の起点） */
  pastDueSince?: number;
  /** 座席数を Stripe に反映できていない */
  seatsDirty: boolean;
  /** 最後に処理した Stripe イベントの時刻（古いイベントの逆戻り防止） */
  stripeLastEventAt: number;
  trialReminderSentAt?: number;
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
  stripe_item_id: string | null;
  past_due_since: number | null;
  seats_dirty: number;
  stripe_last_event_at: number;
  trial_reminder_sent_at: number | null;
  created_at: number;
}

const CONTROL_MIGRATIONS = [
  {
    id: 1,
    name: "tenants",
    sql: `
      CREATE TABLE tenants (
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
    `,
  },
  {
    id: 2,
    name: "billing",
    sql: `
      ALTER TABLE tenants ADD COLUMN stripe_item_id TEXT;
      ALTER TABLE tenants ADD COLUMN past_due_since INTEGER;
      ALTER TABLE tenants ADD COLUMN seats_dirty INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenants ADD COLUMN stripe_last_event_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tenants ADD COLUMN trial_reminder_sent_at INTEGER;
      CREATE TABLE stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL);
    `,
  },
];

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
  stripeItemId: r.stripe_item_id ?? undefined,
  pastDueSince: r.past_due_since ?? undefined,
  seatsDirty: r.seats_dirty === 1,
  stripeLastEventAt: r.stripe_last_event_at,
  trialReminderSentAt: r.trial_reminder_sent_at ?? undefined,
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
    migrate(this.control, CONTROL_MIGRATIONS);
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

  update(
    id: string,
    patch: Partial<Pick<Tenant, "name" | "status" | "trialEndsAt" | "stripeCustomerId" | "stripeSubscriptionId" | "stripeItemId" | "pastDueSince" | "adminEmail" | "stripeLastEventAt" | "trialReminderSentAt">> & { seatsDirty?: boolean },
  ): void {
    const cols: Record<string, string> = {
      name: "name",
      status: "status",
      trialEndsAt: "trial_ends_at",
      stripeCustomerId: "stripe_customer_id",
      stripeSubscriptionId: "stripe_subscription_id",
      stripeItemId: "stripe_item_id",
      pastDueSince: "past_due_since",
      adminEmail: "admin_email",
      stripeLastEventAt: "stripe_last_event_at",
      trialReminderSentAt: "trial_reminder_sent_at",
      seatsDirty: "seats_dirty",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [string, string | number | boolean | null][];
    if (!entries.length) return;
    this.control
      .prepare(`UPDATE tenants SET ${entries.map(([k]) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`)
      .run(...entries.map(([, v]) => (typeof v === "boolean" ? Number(v) : v)), id);
  }

  /** 支払い遅延の起点を消す（支払いが回復したとき） */
  clearPastDue(id: string): void {
    this.control.prepare("UPDATE tenants SET past_due_since = NULL WHERE id = ?").run(id);
  }

  /** Stripe のイベントを処理済みとして記録する。すでに記録済み（重複配信）なら false */
  recordStripeEvent(eventId: string, type: string, nowMs: number): boolean {
    return this.control.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").run(eventId, type, nowMs).changes > 0;
  }

  /** 処理に失敗したイベントの記録を消し、再配信で再処理できるようにする */
  forgetStripeEvent(eventId: string): void {
    this.control.prepare("DELETE FROM stripe_events WHERE id = ?").run(eventId);
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

  /** テナント DB のファイルパス（メモリ上の場合は undefined） */
  tenantFile(tenantId: string): string | undefined {
    return this.tenantDir === ":memory:" ? undefined : join(this.tenantDir, `${tenantId}.db`);
  }

  /** 管理用DBの一貫したスナップショットを file に書き出す */
  backupControl(file: string): void {
    this.control.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  /** 会社のデータを完全に削除する（元に戻せない）。先にバックアップ・書き出しをしておくこと */
  purge(tenantId: string): void {
    const open = this.open.get(tenantId);
    if (open) {
      open.db.close();
      this.open.delete(tenantId);
    }
    const f = this.tenantFile(tenantId);
    if (f) for (const x of [f, `${f}-wal`, `${f}-shm`]) rmSync(x, { force: true });
    this.delete(tenantId);
  }

  close(): void {
    for (const v of this.open.values()) v.db.close();
    this.open.clear();
    this.control.close();
  }
}
