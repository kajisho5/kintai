import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  addDays,
  deriveDay,
  MAX_SHIFT_MIN,
  dowOf,
  durJa,
  hhmm,
  isDate,
  isYm,
  type AttendanceDetailResponse,
  type AttendanceListResponse,
  type DashboardResponse,
  type Employee,
  type LeaveResponse,
  type MonthData,
  type MonthSummary,
  type PunchKind,
  type PunchStateResponse,
  type RequestView,
  type Risk,
  type RiskSummary,
} from "../../domain";
import { ApiError, brief, parse, requireAdmin, type Env } from "../context";
import { audit, tx, type Db } from "../db";
import { snapshot, type Snapshot } from "../repo";

const ctx = (c: Context<Env>) => ({ db: c.get("db"), clock: c.get("clock") });

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
    periodOvertimeMin: m.result.periodOvertimeMin,
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

/** 打刻・勤怠・申請・有給。ログイン済みで、テナントの DB が解決されている前提 */
export function workRoutes(): Hono<Env> {
  const app = new Hono<Env>();

// ---- 打刻 ----

const punchState = (snap: Snapshot, me: Employee): PunchStateResponse => {
  const { ledger } = snap;
  const shift = ledger.shiftFor(me.id, snap.nowMin);
  const day = ledger.todayResult(me, snap.nowMin);
  const d = deriveDay(ledger.eventsOf(me.id, shift.date));
  const ym = snap.today.slice(0, 7);
  const month = ledger.monthOf(me, ym);
  const risk = ledger.riskOf(me);
  return {
    date: shift.date,
    offsetMin: shift.offset,
    nowMin: snap.nowMin + shift.offset,
    events: { in: d.in, out: d.out, breaks: d.breaks, openBreak: d.openBreak },
    day,
    // 月をまたいで終わる日またぎの勤務は、前月の勤務として扱うので、今月の累計には足さない
    monthOvertimeMin: month.result.overtimeMin + (shift.date.slice(0, 7) === ym ? day.dailyOvertimeMin : 0),
    outlook: risk.outlook,
    riskLevel: risk.level,
    leaveRemaining: ledger.leaveOf(me).remaining,
  };
};

app.get("/api/punch/today", (c) => {
  const { db, clock } = ctx(c);
  return c.json(punchState(snapshot(db, clock), c.get("me")));
});

app.post("/api/punch", async (c) => {
  const { db, clock } = ctx(c);
  const me = c.get("me");
  const { action } = parse(z.object({ action: z.enum(["in", "out", "break_start", "break_end"]) }), await c.req.json().catch(() => null));
  const now = clock.now();
  const min = Math.floor(now.min);
  const eventsOn = (date: string) =>
    deriveDay(db.prepare("SELECT emp_id AS empId, date, kind, min, seq FROM punch_events WHERE emp_id = ? AND date = ? ORDER BY seq").all(me.id, date) as never);
  tx(db, () => {
    const yesterday = addDays(now.date, -1);
    const today = eventsOn(now.date);
    const prev = eventsOn(yesterday);
    // 昨日の出勤から退勤していない勤務が続いている（日またぎ）なら、その勤務への打刻とする
    const carrying = today.in === undefined && prev.in !== undefined && prev.out === undefined && 1440 + min - prev.in <= MAX_SHIFT_MIN;
    if (action === "in" && carrying) throw new ApiError(409, "前の勤務（昨日の出勤）が退勤になっていません。先に退勤を記録してください");
    const target = carrying ? { date: yesterday, off: 1440, d: prev } : { date: now.date, off: 0, d: today };
    const d = target.d;
    const at = min + target.off;
    if (action === "in" && d.in !== undefined) throw new ApiError(409, "本日はすでに出勤を記録しています");
    if (action !== "in" && d.in === undefined) throw new ApiError(409, "先に出勤を記録してください");
    if (d.out !== undefined) throw new ApiError(409, "本日はすでに退勤を記録しています");
    if (action === "break_start" && d.openBreak !== undefined) throw new ApiError(409, "すでに休憩中です");
    if (action === "break_end" && d.openBreak === undefined) throw new ApiError(409, "休憩を開始していません");
    const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, source, created_at) VALUES (?, ?, ?, ?, 'punch', ?)");
    // 休憩中の退勤は、休憩を退勤時刻で閉じてから記録する
    if (action === "out" && d.openBreak !== undefined) ins.run(me.id, target.date, "break_end", at, now.ts);
    ins.run(me.id, target.date, action, at, now.ts);
    audit(db, now.ts, me.id, "punch", { action: PUNCH_LABEL[action], date: target.date, min: at });
  });
  return c.json(punchState(snapshot(db, clock), me));
});

// ---- ダッシュボード ----

app.get("/api/dashboard", (c) => {
  const { db, clock } = ctx(c);
  requireAdmin(c);
  const snap = snapshot(db, clock);
  const active = snap.employees.filter((e) => e.hired <= snap.today);
  const rows = active.map((e) => snap.ledger.todayRow(e, snap.nowMin));
  const risks = active
    .map((e) => ({ e, r: snap.ledger.riskOf(e) }))
    .sort((a, b) => b.r.outlook.projOvertime - a.r.outlook.projOvertime);
  const watchAll = risks.filter((x) => x.r.level !== "ok");
  const pendingAll = listRequests(db, snap, { status: "pending" });
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
  const { db, clock } = ctx(c);
  requireAdmin(c);
  const snap = snapshot(db, clock);
  const ym = ymParam(c, snap);
  const body: AttendanceListResponse = {
    ym,
    months: snap.fyMonths,
    today: snap.today,
    rows: snap.allEmployees
      .filter((e) => e.hired.slice(0, 7) <= ym && (!e.leftOn || e.leftOn.slice(0, 7) >= ym))
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
  const { db, clock } = ctx(c);
  const me = c.get("me");
  const id = c.req.param("id");
  if (me.role !== "admin" && me.id !== id) throw new ApiError(403, "他の社員の勤怠は表示できません");
  const snap = snapshot(db, clock);
  const emp = snap.allEmployees.find((e) => e.id === id);
  if (!emp) throw new ApiError(404, "社員が見つかりません");
  const ym = ymParam(c, snap);
  const body: AttendanceDetailResponse = {
    emp: { ...brief(emp), weeklyDays: emp.weeklyDays, weeklyHours: emp.weeklyHours, workStyle: emp.workStyle },
    ym,
    months: snap.fyMonths,
    today: snap.today,
    month: monthSummary(snap.ledger.monthOf(emp, ym)),
    period: snap.ledger.monthOf(emp, ym).period,
    risk: snap.ledger.riskOf(emp, ym),
    series: snap.ledger.overtimeSeries(emp, ym),
    days: snap.ledger.dayRows(emp, ym),
  };
  return c.json(body);
});

// ---- 有給 ----

app.get("/api/leave", (c) => {
  const { db, clock } = ctx(c);
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

function listRequests(db: Db, snap: Snapshot, f: { status?: string; empId?: string }): RequestView[] {
  const rows = db
    .prepare("SELECT * FROM requests WHERE (? IS NULL OR status = ?) AND (? IS NULL OR emp_id = ?) ORDER BY created_at DESC, id DESC")
    .all(f.status ?? null, f.status ?? null, f.empId ?? null, f.empId ?? null) as unknown as ReqRow[];
  const byId = new Map(snap.allEmployees.map((e) => [e.id, e]));
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
        createdDate: snap.dateOf(r.created_at),
      },
    ];
  });
}

app.get("/api/requests", (c) => {
  const { db, clock } = ctx(c);
  const me = c.get("me");
  const status = c.req.query("status");
  if (status && !["pending", "approved", "rejected", "cancelled"].includes(status)) throw new ApiError(400, "状態の指定が正しくありません");
  return c.json(listRequests(db, snapshot(db, clock), { status, empId: me.role === "admin" ? undefined : me.id }));
});

function validateNewRequest(db: Db, snap: Snapshot, me: Employee, req: NewReq): unknown {
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
  const { db, clock } = ctx(c);
  const me = c.get("me");
  const req = parse(newRequestSchema, await c.req.json().catch(() => null));
  const now = clock.now();
  const snap = snapshot(db, clock);
  const payload = validateNewRequest(db, snap, me, req);
  const r = db
    .prepare("INSERT INTO requests (emp_id, kind, date, payload, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(me.id, req.kind, req.date, JSON.stringify(payload), req.reason, now.ts);
  audit(db, now.ts, me.id, "request_create", { id: Number(r.lastInsertRowid), kind: req.kind, date: req.date });
  return c.json({ id: Number(r.lastInsertRowid) }, 201);
});

app.delete("/api/requests/:id", (c) => {
  const { db, clock } = ctx(c);
  const me = c.get("me");
  const id = Number(c.req.param("id"));
  const now = clock.now();
  const r = db.prepare("UPDATE requests SET status = 'cancelled' WHERE id = ? AND emp_id = ? AND status = 'pending'").run(id, me.id);
  if (!r.changes) throw new ApiError(404, "取り下げできる申請が見つかりません");
  audit(db, now.ts, me.id, "request_cancel", { id });
  return c.json({ ok: true });
});

app.post("/api/requests/:id/decision", async (c) => {
  const { db, clock } = ctx(c);
  const admin = requireAdmin(c);
  const id = Number(c.req.param("id"));
  const { decision } = parse(z.object({ decision: z.enum(["approved", "rejected"]) }), await c.req.json().catch(() => null));
  const now = clock.now();
  tx(db, () => {
    const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as unknown as ReqRow | undefined;
    if (!r) throw new ApiError(404, "申請が見つかりません");
    if (r.status !== "pending") throw new ApiError(409, "この申請はすでに処理されています");
    // 承認者と申請者は分ける。ただし管理者が1人だけの会社では自分の申請を処理できる（監査ログに残す）
    const selfApproved = r.emp_id === admin.id;
    if (selfApproved && (db.prepare("SELECT COUNT(*) AS n FROM employees WHERE active = 1 AND role = 'admin'").get() as { n: number }).n > 1) {
      throw new ApiError(403, "自分の申請は承認・却下できません（他の管理者が処理します）");
    }
    if (decision === "approved") applyApproval(db, snapshot(db, clock), r, now.ts);
    db.prepare("UPDATE requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(decision, admin.id, now.ts, id);
    audit(db, now.ts, admin.id, `request_${decision}`, { id, kind: r.kind, emp: r.emp_id, date: r.date, selfApproved });
  });
  return c.json({ ok: true });
});

/** 承認の副作用: 有給は取得日として登録し、打刻修正は修正イベントを追記する */
function applyApproval(db: Db, snap: Snapshot, r: ReqRow, ts: number): void {
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

