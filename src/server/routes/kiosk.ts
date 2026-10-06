import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { KioskHello, KioskIdentified, KioskPunched, KioskTerminal, PunchKind } from "../../domain";
import { burnPasswordCheck, cardHash, LoginThrottle, normalizeCard, verifyPassword } from "../auth";
import { ApiError, parse, requireAdmin, type Env } from "../context";
import { audit, type Db } from "../db";
import { accessOf } from "../plans";
import { punchState, recordPunch } from "../punch";
import { RateLimiter } from "../ratelimit";
import { getEmployee, snapshot } from "../repo";
import { clientIp, type Deps } from "./auth";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const TICKET_SECONDS = 90;
const MAX_TERMINALS = 20;
const ACTION_LABEL: Record<PunchKind, string> = { in: "出勤", out: "退勤", break_start: "休憩開始", break_end: "休憩終了" };

/** 端末のトークンは「会社ID.乱数」。保存するのは乱数のハッシュだけ */
function splitToken(token: string): { tenantId: string; secret: string } | undefined {
  const dot = token.indexOf(".");
  return dot > 0 && token.length <= 120 ? { tenantId: token.slice(0, dot), secret: token.slice(dot + 1) } : undefined;
}

/** 共用の打刻端末（ログインしない）。端末のトークンで会社と端末を特定し、社員はICカードか「社員ID＋暗証番号」で確認する */
export function kioskPublicRoutes({ manager, clockFor, config }: Deps): Hono<Env> {
  const app = new Hono<Env>();
  const terminalLimit = new RateLimiter(600, 10 * 60_000); // 端末ごとの全リクエスト
  const failIp = new RateLimiter(30, 10 * 60_000);
  const failCard = new RateLimiter(20, 10 * 60_000);
  const pinThrottle = new LoginThrottle(5, 5 * 60_000); // 同じ社員に5回失敗 → 5分ロック（端末をまたいで）

  const resolve = (token: string, now: number, ip: string) => {
    const parts = splitToken(token);
    const tenant = parts ? manager.findById(parts.tenantId) : undefined;
    const bad = () => new ApiError(401, "この端末は登録されていないか、無効になっています。管理者に、端末の再登録を依頼してください");
    if (!parts || !tenant) throw bad();
    const db = manager.db(tenant.id);
    const term = db.prepare("SELECT id, name FROM kiosk_terminals WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(parts.secret)) as { id: number; name: string } | undefined;
    if (!term) {
      failIp.record(ip, now);
      throw bad();
    }
    if (tenant.status === "suspended") throw new ApiError(403, "このアカウントは停止されています");
    const key = `${tenant.id}/${term.id}`;
    if (terminalLimit.blocked(key, now)) throw new ApiError(429, "操作が多すぎます。しばらくしてからお試しください");
    terminalLimit.record(key, now);
    const clock = clockFor(tenant.tz);
    return { tenant, db, term, clock, access: accessOf(tenant, now) };
  };

  const touch = (db: Db, termId: number, now: number) => db.prepare("UPDATE kiosk_terminals SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").run(now, termId, now - 60_000);

  app.post("/api/kiosk/hello", async (c) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(120) }), await c.req.json().catch(() => null));
    const ip = clientIp(c, config.trustProxy);
    const now = clockFor("Asia/Tokyo").now().ts;
    if (failIp.blocked(ip, now)) throw new ApiError(429, "しばらく待ってからお試しください");
    const r = resolve(token, now, ip);
    touch(r.db, r.term.id, now);
    const t = r.clock.now();
    return c.json({ company: r.tenant.name, terminal: r.term.name, today: t.date, nowMin: t.min, writable: r.access.writable } satisfies KioskHello);
  });

  app.post("/api/kiosk/identify", async (c) => {
    const b = parse(
      z.object({ token: z.string().min(10).max(120), card: z.string().max(100).optional(), empId: z.string().max(40).optional(), pin: z.string().max(20).optional() }),
      await c.req.json().catch(() => null),
    );
    const ip = clientIp(c, config.trustProxy);
    const now = clockFor("Asia/Tokyo").now().ts;
    if (failIp.blocked(ip, now)) throw new ApiError(429, "認証の失敗が続いたため、しばらくお待ちください");
    const r = resolve(b.token, now, ip);
    const key = `${r.tenant.id}/${r.term.id}`;

    let empId: string | undefined;
    if (b.card !== undefined) {
      if (failCard.blocked(key, now)) throw new ApiError(429, "カードを認識できない状態が続いたため、しばらくお待ちください");
      const normalized = normalizeCard(b.card);
      const row = normalized ? (r.db.prepare("SELECT id FROM employees WHERE card_hash = ? AND active = 1").get(cardHash(r.tenant.id, normalized)) as { id: string } | undefined) : undefined;
      if (!row) {
        failCard.record(key, now);
        throw new ApiError(401, "カードを認識できません。登録されていないか、読み取りに失敗しました");
      }
      empId = row.id;
    } else if (b.empId !== undefined && b.pin !== undefined) {
      const tkey = `${r.tenant.id}|${b.empId}`;
      const until = pinThrottle.lockedUntil(tkey, now);
      if (until) throw new ApiError(423, `暗証番号の入力に続けて失敗したため、しばらくロックしています（あと${Math.ceil((until - now) / 60000)}分）`);
      const row = r.db.prepare("SELECT id, punch_pin_hash AS h FROM employees WHERE id = ? AND active = 1").get(b.empId) as { id: string; h: string | null } | undefined;
      const ok = row?.h ? await verifyPassword(b.pin, row.h) : (await burnPasswordCheck(b.pin), false);
      if (!ok) {
        pinThrottle.failure(tkey, now);
        failIp.record(ip, now);
        audit(r.db, now, b.empId, "kiosk_pin_failed", { terminal: r.term.id });
        throw new ApiError(401, "社員IDか暗証番号が違います");
      }
      pinThrottle.success(tkey);
      empId = row!.id;
    } else {
      throw new ApiError(400, "カードをかざすか、社員IDと暗証番号を入力してください");
    }

    const emp = getEmployee(r.db, empId);
    if (!emp) throw new ApiError(401, "この社員は打刻できません");
    const snap = snapshot(r.db, r.clock);
    const ev = punchState(snap, emp).events;
    const phase: KioskIdentified["phase"] = ev.in === undefined ? "before" : ev.out !== undefined ? "done" : ev.openBreak !== undefined ? "break" : "working";
    const carriedDone = phase === "done" && punchState(snap, emp).offsetMin > 0; // 日またぎの勤務を退勤済み → 次の勤務の出勤はできる
    const allowed: PunchKind[] = phase === "before" || carriedDone ? ["in"] : phase === "working" ? ["break_start", "out"] : phase === "break" ? ["break_end", "out"] : [];
    const ticket = randomBytes(24).toString("base64url");
    r.db.prepare("DELETE FROM kiosk_tickets WHERE expires_at < ?").run(now);
    r.db.prepare("INSERT INTO kiosk_tickets (token_hash, emp_id, terminal_id, expires_at) VALUES (?, ?, ?, ?)").run(sha256(ticket), emp.id, r.term.id, now + TICKET_SECONDS * 1000);
    touch(r.db, r.term.id, now);
    const body: KioskIdentified = { ticket, emp: { id: emp.id, name: emp.name, dept: emp.dept }, allowed, phase, events: { in: ev.in, out: ev.out } };
    return c.json(body);
  });

  app.post("/api/kiosk/punch", async (c) => {
    const b = parse(z.object({ token: z.string().min(10).max(120), ticket: z.string().min(10).max(100), action: z.enum(["in", "out", "break_start", "break_end"]) }), await c.req.json().catch(() => null));
    const ip = clientIp(c, config.trustProxy);
    const now = clockFor("Asia/Tokyo").now().ts;
    const r = resolve(b.token, now, ip);
    const row = r.db.prepare("SELECT emp_id AS empId, expires_at AS exp FROM kiosk_tickets WHERE token_hash = ? AND terminal_id = ?").get(sha256(b.ticket), r.term.id) as { empId: string; exp: number } | undefined;
    if (!row || row.exp < now) throw new ApiError(401, "確認の有効時間が過ぎました。もう一度、カードをかざすか暗証番号を入力してください");
    const emp = getEmployee(r.db, row.empId);
    if (!emp) throw new ApiError(401, "この社員は打刻できません");
    if (!r.access.writable) throw new ApiError(402, "ご契約が有効ではないため、打刻できません。管理者にご連絡ください");
    recordPunch(r.db, r.clock, emp, b.action, { source: "kiosk", actor: `kiosk:${r.term.name}`, detail: { terminal: r.term.id } });
    r.db.prepare("DELETE FROM kiosk_tickets WHERE token_hash = ?").run(sha256(b.ticket)); // 1回限り
    touch(r.db, r.term.id, now);
    const events = punchState(snapshot(r.db, r.clock), emp);
    const at = b.action === "in" ? events.events.in : b.action === "out" ? events.events.out : b.action === "break_start" ? events.events.openBreak : events.events.breaks[events.events.breaks.length - 1]?.end;
    return c.json({ emp: { id: emp.id, name: emp.name }, action: b.action, at: at ?? Math.floor(r.clock.now().min) } satisfies KioskPunched);
  });

  return app;
}

/** 端末の登録・無効化（管理者） */
export function kioskAdminRoutes({ appUrl }: Deps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/api/kiosk/terminals", (c) => {
    requireAdmin(c);
    const rows = c.get("db").prepare("SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM kiosk_terminals ORDER BY id DESC").all() as unknown as {
      id: number;
      name: string;
      createdAt: number;
      lastUsedAt: number | null;
      revokedAt: number | null;
    }[];
    return c.json(rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt ?? undefined, revoked: r.revokedAt !== null }) satisfies KioskTerminal));
  });

  app.post("/api/kiosk/terminals", async (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const { name } = parse(z.object({ name: z.string().trim().min(1, "端末の名前を入力してください").max(30, "端末の名前は30文字以内にしてください") }), await c.req.json().catch(() => null));
    if ((db.prepare("SELECT COUNT(*) AS n FROM kiosk_terminals WHERE revoked_at IS NULL").get() as { n: number }).n >= MAX_TERMINALS) throw new ApiError(409, `端末は${MAX_TERMINALS}台までです`);
    const secret = randomBytes(24).toString("base64url");
    const now = c.get("clock").now().ts;
    const r = db.prepare("INSERT INTO kiosk_terminals (name, token_hash, created_at) VALUES (?, ?, ?)").run(name, sha256(secret), now);
    audit(db, now, admin.id, "kiosk_terminal_add", { id: Number(r.lastInsertRowid), name });
    const token = `${c.get("tenant").id}.${secret}`;
    // トークンは、この応答でしか表示できない（失くしたら、端末を登録し直す）
    return c.json({ id: Number(r.lastInsertRowid), name, token, url: `${appUrl ?? ""}/app/#/kiosk?t=${token}` }, 201);
  });

  app.delete("/api/kiosk/terminals/:id", (c) => {
    const admin = requireAdmin(c);
    const db = c.get("db");
    const id = Number(c.req.param("id"));
    const now = c.get("clock").now().ts;
    const r = db.prepare("UPDATE kiosk_terminals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    if (!r.changes) throw new ApiError(404, "有効な端末が見つかりません");
    db.prepare("DELETE FROM kiosk_tickets WHERE terminal_id = ?").run(id);
    audit(db, now, admin.id, "kiosk_terminal_revoke", { id });
    return c.json({ ok: true });
  });

  return app;
}
