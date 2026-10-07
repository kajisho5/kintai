import { Hono, type Context } from "hono";
import { z } from "zod";
import { buildCsv, isDate, type AuditResponse, type AuditRow } from "../../domain";
import { ApiError, parse, requireAdmin, type Env } from "../context";
import { audit } from "../db";

/** 操作の日本語名 */
export const AUDIT_LABELS: Record<string, string> = {
  login: "ログイン",
  login_failed: "ログイン失敗",
  password_change: "パスワードの変更",
  password_reset_requested: "パスワード再設定の申し込み",
  password_reset: "パスワードの再設定",
  signup: "会社の登録",
  email_verification_sent: "確認メールの送信",
  email_verified: "メールアドレスの確認",
  admin_email_changed: "管理者のメールアドレスの変更",
  employee_create: "社員の追加",
  employee_update: "社員情報の変更",
  employee_import: "社員のCSV取り込み",
  employee_deactivate: "退職処理",
  employee_reactivate: "復職",
  employee_reset_password: "パスワードの再発行",
  punch: "打刻",
  punch_kiosk: "打刻（共用端末）",
  punch_pin_issue: "暗証番号の発行",
  punch_pin_remove: "暗証番号の削除",
  card_register: "ICカードの登録",
  card_remove: "ICカードの削除",
  kiosk_pin_failed: "共用端末の暗証番号の誤り",
  kiosk_terminal_add: "共用端末の登録",
  kiosk_terminal_revoke: "共用端末の無効化",
  request_create: "申請",
  request_cancel: "申請の取り下げ",
  request_approved: "申請の承認",
  request_rejected: "申請の却下",
  settings_update: "会社設定の変更",
  holiday_add: "会社の休日の追加",
  holiday_remove: "休日の削除",
  geo_site_add: "打刻場所の追加",
  geo_site_remove: "打刻場所の削除",
  schedule_update: "シフトの変更",
  schedule_import: "シフトのCSV取り込み",
  export: "全データの書き出し",
  seed: "デモデータの投入",
};

interface Row {
  id: number;
  at: number;
  actor: string;
  action: string;
  detail: string;
}

const JST = "+09:00";
const startOf = (date: string) => Date.parse(`${date}T00:00:00${JST}`);

const filterSchema = z.object({
  action: z.string().max(60).optional(),
  actor: z.string().max(60).optional(),
  from: z.string().refine(isDate).optional(),
  to: z.string().refine(isDate).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 操作記録（監査ログ）の閲覧。管理者のみ */
export function auditRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  const query = (c: Context<Env>, limit: number) => {
    const f = parse(filterSchema, Object.fromEntries(new URL(c.req.url).searchParams));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.action) {
      where.push("action = ?");
      args.push(f.action);
    }
    if (f.actor) {
      where.push("actor = ?");
      args.push(f.actor);
    }
    if (f.from) {
      where.push("at >= ?");
      args.push(startOf(f.from));
    }
    if (f.to) {
      where.push("at < ?");
      args.push(startOf(f.to) + 86400_000);
    }
    if (f.before) {
      where.push("id < ?");
      args.push(f.before);
    }
    const rows = c
      .get("db")
      .prepare(`SELECT id, at, actor, action, detail FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit + 1) as unknown as Row[];
    return { rows, f };
  };

  const view = (c: Context<Env>, rows: Row[]): AuditRow[] => {
    const names = new Map((c.get("db").prepare("SELECT id, name FROM employees").all() as { id: string; name: string }[]).map((e) => [e.id, e.name]));
    return rows.map((r) => {
      let detail: unknown = {};
      try {
        detail = JSON.parse(r.detail);
      } catch {
        /* 壊れた記録は、そのまま空で返す */
      }
      return { id: r.id, at: r.at, actor: r.actor, actorName: names.get(r.actor), action: r.action, label: AUDIT_LABELS[r.action] ?? r.action, detail };
    });
  };

  app.get("/api/audit", (c) => {
    requireAdmin(c);
    const { rows, f } = query(c, 50);
    const page = rows.slice(0, f.limit);
    const body: AuditResponse = {
      rows: view(c, page),
      nextBefore: rows.length > f.limit ? page[page.length - 1]!.id : undefined,
      actions: Object.entries(AUDIT_LABELS).map(([action, label]) => ({ action, label })),
    };
    return c.json(body);
  });

  app.get("/api/audit/export", (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const f = parse(filterSchema.omit({ before: true, limit: true }), Object.fromEntries(new URL(c.req.url).searchParams));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.action) (where.push("action = ?"), args.push(f.action));
    if (f.actor) (where.push("actor = ?"), args.push(f.actor));
    if (f.from) (where.push("at >= ?"), args.push(startOf(f.from)));
    if (f.to) (where.push("at < ?"), args.push(startOf(f.to) + 86400_000));
    const MAX = 50_000;
    const rows = db.prepare(`SELECT id, at, actor, action, detail FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, MAX + 1) as unknown as Row[];
    if (rows.length > MAX) throw new ApiError(400, `${MAX.toLocaleString()}件を超えるため、期間か操作で絞り込んでください`);
    const out = view(c, rows);
    const fmt = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const csv = buildCsv([
      ["日時（日本時間）", "操作者ID", "操作者", "操作", "内容"],
      ...out.map((r) => [fmt(r.at), r.actor, r.actorName ?? "", r.label, JSON.stringify(r.detail)]),
    ]);
    audit(db, c.get("clock").now().ts, admin.id, "export", { kind: "audit", count: out.length });
    const today = c.get("clock").now().date;
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${today}.csv"; filename*=UTF-8''${encodeURIComponent(`操作記録_${today}.csv`)}`,
    });
  });

  return app;
}
