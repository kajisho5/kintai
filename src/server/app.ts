import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  durJa,
  hhmm,
  isDate,
  isYm,
  addDays,
  dowOf,
  deriveDay,
  type AttendanceDetailResponse,
  type AttendanceListResponse,
  type DashboardResponse,
  type Employee,
  type EmpBrief,
  type LeaveResponse,
  type MeResponse,
  type MonthData,
  type MonthSummary,
  type PunchKind,
  type PunchStateResponse,
  type RequestView,
  type Risk,
  type RiskSummary,
} from "../domain";
import { checkCredentials, createSession, destroySession, hashPassword, LoginThrottle, sessionEmployee } from "./auth";
import type { Clock } from "./clock";
import { audit, tx, type Db } from "./db";
import { getEmployee, snapshot, type Snapshot } from "./repo";

export interface AppConfig {
  secureCookie: boolean;
  sessionHours: number;
}

export class ApiError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 423, message: string) {
    super(message);
  }
}

type Env = { Variables: { me: Employee } };

const COOKIE = "kintai_session";

const brief = (e: Pick<Employee, "id" | "name" | "dept" | "title" | "kind">): EmpBrief => ({
  id: e.id,
  name: e.name,
  dept: e.dept,
  title: e.title,
  kind: e.kind,
});

function monthSummary(m: MonthData): MonthSummary {
  return {
    workDays: m.workDays,
    leaveDays: m.leaveDays,
    absentDays: m.absentDays,
    incompleteDays: m.incompleteDays,
    workMin: m.result.workMin,
    legalInMin: m.result.days.reduce((s, d) => s + d.legalInMin, 0),
    overtimeMin: m.result.overtimeMin,
    weeklyOvertimeMin: m.result.weeklyOvertimeMin,
    nightMin: m.result.nightMin,
    holidayMin: m.result.legalHolidayMin,
  };
}

const riskSummary = (r: Risk): RiskSummary => ({
  level: r.level,
  alerts: r.alerts,
  yearOvertime: r.yearOvertime,
  over45Count: r.over45Count,
  outlook: r.outlook,
});

// ---------------------------------------------------------------- 入力の検証

const minute = z.number().int().min(0).max(1799);
const dateStr = z.string().refine(isDate, "日付の形式が正しくありません");
const reasonStr = z.string().trim().min(1, "理由を入力してください").max(200, "理由は200文字以内で入力してください");

const newRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["残業申請", "休日出勤"]), date: dateStr, start: minute, end: minute, reason: reasonStr }),
  z.object({ kind: z.literal("有給申請"), date: dateStr, days: z.union([z.literal(1), z.literal(0.5)]), reason: reasonStr }),
  z.object({ kind: z.literal("打刻修正"), date: dateStr, in: minute.optional(), out: minute.optional(), reason: reasonStr }),
]);

type NewReq = z.infer<typeof newRequestSchema>;

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, r.error.issues[0]?.message ?? "入力が正しくありません");
  return r.data;
}

const PUNCH_LABEL: Record<PunchKind, string> = { in: "出勤", out: "退勤", break_start: "休憩開始", break_end: "休憩終了" };

interface ReqRow {
  id: number;
  emp_id: string;
  kind: RequestView["kind"];
  date: string;
  payload: string;
  reason: string;
  status: RequestView["status"];
  created_at: number;
}

// ---------------------------------------------------------------- アプリ

export function createApp(db: Db, clock: Clock, config: AppConfig): Hono<Env> {
  const app = new Hono<Env>();
  const throttle = new LoginThrottle();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // CSRF対策: 別オリジンからの更新系リクエストを拒否（CORSは無効のまま）
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== c.req.header("host")) throw new ApiError(403, "不正なリクエストです");
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "サーバーでエラーが発生しました" }, 500);
  });

  app.notFound((c) => c.json({ error: "見つかりません" }, 404));

  // ---- 認証 ----

  app.post("/api/auth/login", async (c) => {
    const body = parse(z.object({ id: z.string().min(1).max(50), password: z.string().min(1).max(200) }), await c.req.json().catch(() => null));
    const now = clock.now();
    const until = throttle.lockedUntil(body.id, now.ts);
    if (until) throw new ApiError(423, `ログインに続けて失敗したため、しばらくロックしています（あと${Math.ceil((until - now.ts) / 60000)}分）`);
    const r = checkCredentials(db, body.id, body.password);
    if (!r.ok) {
      throttle.failure(body.id, now.ts);
      audit(db, now.ts, body.id, "login_failed", {});
      throw new ApiError(401, "社員IDまたはパスワードが違います");
    }
    throttle.success(body.id);
    const ttl = config.sessionHours * 3600_000;
    const token = createSession(db, r.id, now.ts, ttl);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: config.secureCookie, path: "/", maxAge: config.sessionHours * 3600 });
    audit(db, now.ts, r.id, "login", {});
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    destroySession(db, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // 以降は要ログイン
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/login" || c.req.path === "/api/auth/logout") return next();
    const id = sessionEmployee(db, getCookie(c, COOKIE), clock.now().ts);
    const me = id ? getEmployee(db, id) : undefined;
    if (!me) throw new ApiError(401, "ログインしてください");
    c.set("me", me);
    await next();
  });

  app.post("/api/auth/password", async (c) => {
    const me = c.get("me");
    const body = parse(
      z.object({ current: z.string().min(1).max(200), next: z.string().min(8, "新しいパスワードは8文字以上にしてください").max(200) }),
      await c.req.json().catch(() => null),
    );
    const now = clock.now();
    const until = throttle.lockedUntil(me.id, now.ts);
    if (until) throw new ApiError(423, "しばらくしてからもう一度お試しください");
    if (!checkCredentials(db, me.id, body.current).ok) {
      throttle.failure(me.id, now.ts);
      throw new ApiError(400, "現在のパスワードが違います");
    }
    if (body.next === body.current) throw new ApiError(400, "現在と同じパスワードは使えません");
    throttle.success(me.id);
    db.prepare("UPDATE employees SET password_hash = ? WHERE id = ?").run(hashPassword(body.next), me.id);
    // 他の端末のログインは無効にし、この端末には新しいセッションを発行する
    db.prepare("DELETE FROM sessions WHERE emp_id = ?").run(me.id);
    const token = createSession(db, me.id, now.ts, config.sessionHours * 3600_000);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: config.secureCookie, path: "/", maxAge: config.sessionHours * 3600 });
    audit(db, now.ts, me.id, "password_change", {});
    return c.json({ ok: true });
  });

  const requireAdmin = (c: Context<Env>): Employee => {
    const me = c.get("me");
    if (me.role !== "admin") throw new ApiError(403, "この操作には管理者権限が必要です");
    return me;
  };

  const pendingCount = () => (db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").get() as { n: number }).n;

  app.get("/api/me", (c) => {
    const me = c.get("me");
    const now = clock.now();
    const body: MeResponse = {
      employee: { ...brief(me), role: me.role },
      today: now.date,
      nowMin: now.min,
      pending: me.role === "admin" ? pendingCount() : 0,
    };
    return c.json(body);
  });

  // ---- 打刻 ----

  const punchState = (snap: Snapshot, me: Employee): PunchStateResponse => {
    const { ledger } = snap;
    const day = ledger.todayResult(me, snap.nowMin);
    const month = ledger.monthOf(me, snap.today.slice(0, 7));
    const d = deriveDay(ledger.eventsOf(me.id, snap.today));
    const risk = ledger.riskOf(me);
    return {
      date: snap.today,
      nowMin: snap.nowMin,
      events: { in: d.in, out: d.out, breaks: d.breaks, openBreak: d.openBreak },
      day,
      monthOvertimeMin: month.result.overtimeMin + day.dailyOvertimeMin,
      outlook: risk.outlook,
      riskLevel: risk.level,
      leaveRemaining: ledger.leaveOf(me).remaining,
    };
  };

  app.get("/api/punch/today", (c) => c.json(punchState(snapshot(db, clock), c.get("me"))));

  app.post("/api/punch", async (c) => {
    const me = c.get("me");
    const { action } = parse(z.object({ action: z.enum(["in", "out", "break_start", "break_end"]) }), await c.req.json().catch(() => null));
    const now = clock.now();
    const min = Math.floor(now.min);
    tx(db, () => {
      const rows = db.prepare("SELECT emp_id AS empId, date, kind, min, seq FROM punch_events WHERE emp_id = ? AND date = ? ORDER BY seq").all(me.id, now.date) as never;
      const d = deriveDay(rows);
      if (action === "in" && d.in !== undefined) throw new ApiError(409, "本日はすでに出勤を記録しています");
      if (action !== "in" && d.in === undefined) throw new ApiError(409, "先に出勤を記録してください");
      if (d.out !== undefined) throw new ApiError(409, "本日はすでに退勤を記録しています");
      if (action === "break_start" && d.openBreak !== undefined) throw new ApiError(409, "すでに休憩中です");
      if (action === "break_end" && d.openBreak === undefined) throw new ApiError(409, "休憩を開始していません");
      if (action === "out" && d.openBreak !== undefined) {
        // 休憩中の退勤は、休憩を退勤時刻で閉じてから記録する
        db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, source, created_at) VALUES (?, ?, 'break_end', ?, 'punch', ?)").run(me.id, now.date, min, now.ts);
      }
      db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, source, created_at) VALUES (?, ?, ?, ?, 'punch', ?)").run(me.id, now.date, action, min, now.ts);
      audit(db, now.ts, me.id, "punch", { action: PUNCH_LABEL[action], date: now.date, min });
    });
    return c.json(punchState(snapshot(db, clock), me));
  });

  // ---- ダッシュボード ----

  app.get("/api/dashboard", (c) => {
    requireAdmin(c);
    const snap = snapshot(db, clock);
    const active = snap.employees.filter((e) => e.hired <= snap.today);
    const rows = active.map((e) => snap.ledger.todayRow(e, snap.nowMin));
    const risks = active
      .map((e) => ({ e, r: snap.ledger.riskOf(e) }))
      .sort((a, b) => b.r.outlook.projOvertime - a.r.outlook.projOvertime);
    const watchAll = risks.filter((x) => x.r.level !== "ok");
    const pendingAll = listRequests(snap, { status: "pending" });
    const body: DashboardResponse = {
      today: snap.today,
      nowMin: snap.nowMin,
      headcount: active.length,
      rows,
      watch: watchAll.slice(0, 8).map((x) => ({ emp: brief(x.e), risk: riskSummary(x.r) })),
      watchTotal: watchAll.length,
      violating: watchAll.filter((x) => x.r.level === "violation").length,
      pending: pendingAll.slice(0, 5),
      pendingTotal: pendingAll.length,
    };
    return c.json(body);
  });

  // ---- 勤怠 ----

  const ymParam = (c: Context<Env>, snap: Snapshot): string => {
    const ym = c.req.query("ym") ?? snap.today.slice(0, 7);
    if (!isYm(ym) || !snap.fyMonths.includes(ym)) throw new ApiError(400, "対象月が正しくありません");
    return ym;
  };

  app.get("/api/attendance", (c) => {
    requireAdmin(c);
    const snap = snapshot(db, clock);
    const ym = ymParam(c, snap);
    const body: AttendanceListResponse = {
      ym,
      months: snap.fyMonths,
      today: snap.today,
      rows: snap.employees
        .filter((e) => e.hired.slice(0, 7) <= ym)
        .map((e) => ({
          emp: brief(e),
          month: monthSummary(snap.ledger.monthOf(e, ym)),
          risk: riskSummary(snap.ledger.riskOf(e, ym)),
          leaveRemaining: snap.ledger.leaveOf(e).remaining,
        })),
    };
    return c.json(body);
  });

  app.get("/api/attendance/:id", (c) => {
    const me = c.get("me");
    const id = c.req.param("id");
    if (me.role !== "admin" && me.id !== id) throw new ApiError(403, "他の社員の勤怠は表示できません");
    const snap = snapshot(db, clock);
    const emp = snap.employees.find((e) => e.id === id);
    if (!emp) throw new ApiError(404, "社員が見つかりません");
    const ym = ymParam(c, snap);
    const body: AttendanceDetailResponse = {
      emp: { ...brief(emp), weeklyDays: emp.weeklyDays, weeklyHours: emp.weeklyHours },
      ym,
      months: snap.fyMonths,
      today: snap.today,
      month: monthSummary(snap.ledger.monthOf(emp, ym)),
      risk: snap.ledger.riskOf(emp, ym),
      series: snap.ledger.overtimeSeries(emp, ym),
      days: snap.ledger.dayRows(emp, ym),
    };
    return c.json(body);
  });

  // ---- 有給 ----

  app.get("/api/leave", (c) => {
    const me = c.get("me");
    const snap = snapshot(db, clock);
    const targets = me.role === "admin" ? snap.employees : snap.employees.filter((e) => e.id === me.id);
    const body: LeaveResponse = { today: snap.today, rows: targets.map((e) => snap.ledger.leaveOf(e)) };
    return c.json(body);
  });

  // ---- 申請 ----

  function requestDetail(snap: Snapshot, r: ReqRow): string {
    const p = JSON.parse(r.payload) as Record<string, number>;
    if (r.kind === "残業申請" || r.kind === "休日出勤") {
      return `${hhmm(p.start!)} → ${hhmm(p.end!)}（${durJa(p.end! - p.start!)}）`;
    }
    if (r.kind === "有給申請") return p.days === 0.5 ? "半休 0.5日" : "全日 1日";
    const d = deriveDay(snap.ledger.eventsOf(r.emp_id, r.date));
    const parts: string[] = [];
    if (p.in !== undefined) parts.push(`出勤 ${d.in !== undefined ? hhmm(d.in) : "未打刻"} → ${hhmm(p.in)}`);
    if (p.out !== undefined) parts.push(`退勤 ${d.out !== undefined ? hhmm(d.out) : "未打刻"} → ${hhmm(p.out)}`);
    return parts.join(" / ");
  }

  function listRequests(snap: Snapshot, f: { status?: string; empId?: string }): RequestView[] {
    const rows = db
      .prepare("SELECT * FROM requests WHERE (? IS NULL OR status = ?) AND (? IS NULL OR emp_id = ?) ORDER BY created_at DESC, id DESC")
      .all(f.status ?? null, f.status ?? null, f.empId ?? null, f.empId ?? null) as unknown as ReqRow[];
    const byId = new Map(snap.employees.map((e) => [e.id, e]));
    return rows.flatMap((r) => {
      const e = byId.get(r.emp_id);
      if (!e) return [];
      return [
        {
          id: r.id,
          emp: brief(e),
          kind: r.kind,
          date: r.date,
          detail: requestDetail(snap, r),
          reason: r.reason,
          status: r.status,
          createdDate: new Date(r.created_at + 9 * 3600_000).toISOString().slice(0, 10),
        },
      ];
    });
  }

  app.get("/api/requests", (c) => {
    const me = c.get("me");
    const status = c.req.query("status");
    if (status && !["pending", "approved", "rejected", "cancelled"].includes(status)) throw new ApiError(400, "状態の指定が正しくありません");
    return c.json(listRequests(snapshot(db, clock), { status, empId: me.role === "admin" ? undefined : me.id }));
  });

  function validateNewRequest(snap: Snapshot, me: Employee, req: NewReq): unknown {
    const { today, ledger } = snap;
    if (req.date < addDays(today, -62) || req.date > addDays(today, 366)) throw new ApiError(400, "対象日は過去2か月〜1年先の範囲で指定してください");
    if (req.date < me.hired) throw new ApiError(400, "入社日より前の日付は指定できません");
    const w = dowOf(req.date);
    const restDay = w === 0 || !!ledger.cal.holidays[req.date] || !me.workDays.includes(w);

    if (req.kind === "残業申請" || req.kind === "休日出勤") {
      if (req.end <= req.start) throw new ApiError(400, "終了時刻は開始時刻より後にしてください");
      if (req.end - req.start > 16 * 60) throw new ApiError(400, "申請できるのは16時間までです");
      if (req.kind === "休日出勤" && !restDay) throw new ApiError(400, "所定の労働日には休日出勤を申請できません");
      if (req.kind === "残業申請" && restDay) throw new ApiError(400, "休日の勤務は「休日出勤」で申請してください");
      return { start: req.start, end: req.end };
    }
    if (req.kind === "有給申請") {
      if (restDay) throw new ApiError(400, "休日には有給を申請できません");
      if (ledger.leaveDaysOn(me.id, req.date) > 0) throw new ApiError(409, "その日はすでに有給が登録されています");
      const dup = db.prepare("SELECT 1 FROM requests WHERE emp_id = ? AND kind = '有給申請' AND date = ? AND status = 'pending'").get(me.id, req.date);
      if (dup) throw new ApiError(409, "その日の有給申請はすでに提出済みです");
      const info = ledger.leaveOf(me);
      if (!info.lastGrant || !info.periodEnd) throw new ApiError(400, "有給はまだ付与されていません");
      if (req.date < info.lastGrant || req.date >= info.periodEnd) {
        throw new ApiError(400, `現在の付与期間（${info.lastGrant}〜${info.periodEnd}）内の日付を指定してください`);
      }
      if (info.carry + info.granted - info.taken - info.planned < req.days) throw new ApiError(409, "有給の残日数が足りません");
      return { days: req.days };
    }
    // 打刻修正
    if (req.kind !== "打刻修正") throw new ApiError(400, "申請の種類が正しくありません");
    if (req.date > today) throw new ApiError(400, "未来の日付の打刻は修正できません");
    if (req.in === undefined && req.out === undefined) throw new ApiError(400, "出勤か退勤のどちらかを入力してください");
    const cur = deriveDay(ledger.eventsOf(me.id, req.date));
    const inMin = req.in ?? cur.in;
    const outMin = req.out ?? cur.out;
    if (inMin === undefined || outMin === undefined) throw new ApiError(400, "その日の打刻がありません。出勤と退勤の両方を入力してください");
    if (outMin <= inMin) throw new ApiError(400, "退勤は出勤より後の時刻にしてください");
    return { in: req.in, out: req.out };
  }

  app.post("/api/requests", async (c) => {
    const me = c.get("me");
    const req = parse(newRequestSchema, await c.req.json().catch(() => null));
    const now = clock.now();
    const snap = snapshot(db, clock);
    const payload = validateNewRequest(snap, me, req);
    const r = db
      .prepare("INSERT INTO requests (emp_id, kind, date, payload, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(me.id, req.kind, req.date, JSON.stringify(payload), req.reason, now.ts);
    audit(db, now.ts, me.id, "request_create", { id: Number(r.lastInsertRowid), kind: req.kind, date: req.date });
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  app.delete("/api/requests/:id", (c) => {
    const me = c.get("me");
    const id = Number(c.req.param("id"));
    const now = clock.now();
    const r = db.prepare("UPDATE requests SET status = 'cancelled' WHERE id = ? AND emp_id = ? AND status = 'pending'").run(id, me.id);
    if (!r.changes) throw new ApiError(404, "取り下げできる申請が見つかりません");
    audit(db, now.ts, me.id, "request_cancel", { id });
    return c.json({ ok: true });
  });

  app.post("/api/requests/:id/decision", async (c) => {
    const admin = requireAdmin(c);
    const id = Number(c.req.param("id"));
    const { decision } = parse(z.object({ decision: z.enum(["approved", "rejected"]) }), await c.req.json().catch(() => null));
    const now = clock.now();
    tx(db, () => {
      const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as unknown as ReqRow | undefined;
      if (!r) throw new ApiError(404, "申請が見つかりません");
      if (r.status !== "pending") throw new ApiError(409, "この申請はすでに処理されています");
      if (r.emp_id === admin.id) throw new ApiError(403, "自分の申請は承認・却下できません");
      if (decision === "approved") applyApproval(snapshot(db, clock), r, now.ts);
      db.prepare("UPDATE requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(decision, admin.id, now.ts, id);
      audit(db, now.ts, admin.id, `request_${decision}`, { id, kind: r.kind, emp: r.emp_id, date: r.date });
    });
    return c.json({ ok: true });
  });

  /** 承認の副作用: 有給は取得日として登録し、打刻修正は修正イベントを追記する */
  function applyApproval(snap: Snapshot, r: ReqRow, ts: number): void {
    const p = JSON.parse(r.payload) as { days?: number; in?: number; out?: number };
    if (r.kind === "有給申請") {
      const emp = snap.employees.find((e) => e.id === r.emp_id);
      if (!emp) throw new ApiError(404, "社員が見つかりません");
      if (snap.ledger.leaveDaysOn(emp.id, r.date) > 0) throw new ApiError(409, "その日はすでに有給が登録されています");
      const info = snap.ledger.leaveOf(emp);
      if (info.carry + info.granted - info.taken - info.planned < p.days!) throw new ApiError(409, "有給の残日数が足りません");
      db.prepare("INSERT INTO paid_leave (emp_id, date, days) VALUES (?, ?, ?)").run(emp.id, r.date, p.days!);
    } else if (r.kind === "打刻修正") {
      const cur = deriveDay(snap.ledger.eventsOf(r.emp_id, r.date));
      const inMin = p.in ?? cur.in;
      const outMin = p.out ?? cur.out;
      if (inMin === undefined || outMin === undefined || outMin <= inMin) throw new ApiError(409, "現在の打刻と矛盾するため承認できません");
      const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, source, created_at) VALUES (?, ?, ?, ?, 'correction', ?)");
      if (p.in !== undefined) ins.run(r.emp_id, r.date, "in", p.in, ts);
      if (p.out !== undefined) ins.run(r.emp_id, r.date, "out", p.out, ts);
    }
  }

  return app;
}
