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
  type Rounding,
  periodOfYm,
  roundMonthTotal,
  WORK_STYLE_LABEL,
  buildCsv,
  ymOfDate,
} from "../../domain";
import { ApiError, brief, parse, requireAdmin, type Env } from "../context";
import { audit, tx, type Db } from "../db";
import { recordPunch, punchState } from "../punch";
import { snapshot, type Snapshot } from "../repo";

const ctx = (c: Context<Env>) => ({ db: c.get("db"), clock: c.get("clock") });

function monthSummary(m: MonthData, rounding: Rounding = "none"): MonthSummary {
  const r = (n: number) => roundMonthTotal(n, rounding);
  return {
    rounded: rounding !== "none" || undefined,
    workDays: m.workDays,
    leaveDays: m.leaveDays,
    absentDays: m.absentDays,
    incompleteDays: m.incompleteDays,
    workMin: m.result.workMin,
    legalInMin: m.result.days.reduce((s, d) => s + d.legalInMin, 0),
    overtimeMin: r(m.result.overtimeMin),
    weeklyOvertimeMin: m.result.weeklyOvertimeMin,
    periodOvertimeMin: m.result.periodOvertimeMin,
    nightMin: r(m.result.nightMin),
    holidayMin: r(m.result.legalHolidayMin),
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

app.get("/api/punch/today", (c) => {
  const { db, clock } = ctx(c);
  const me = c.get("me");
  return c.json(punchState(snapshot(db, clock, { only: [me.id] }), me));
});

const geoSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional() });

app.post("/api/punch", async (c) => {
  const { db, clock } = ctx(c);
  const me = c.get("me");
  const { action, geo } = parse(z.object({ action: z.enum(["in", "out", "break_start", "break_end"]), geo: geoSchema.optional() }), await c.req.json().catch(() => null));
  recordPunch(db, clock, me, action, { geo });
  return c.json(punchState(snapshot(db, clock, { only: [me.id] }), me));
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
  const ym = c.req.query("ym") ?? snap.currentYm;
  if (!isYm(ym) || !snap.pickerMonths.includes(ym)) throw new ApiError(400, "対象月が正しくありません");
  return ym;
};

/** 勤怠の画面・CSV用。前の協定期間の最終月が指定されたときは、36協定のチェックに必要な前の期間ぶんも読み込む */
const attendanceSnapshot = (c: Context<Env>, only?: string[]): Snapshot => snapshot(c.get("db"), c.get("clock"), { backTo: c.req.query("ym"), only });

app.get("/api/attendance", (c) => {
  requireAdmin(c);
  const snap = attendanceSnapshot(c);
  const ym = ymParam(c, snap);
  const range = periodOfYm(ym, snap.settings.closingDay);
  const body: AttendanceListResponse = {
    ym,
    range: { from: range.start, to: range.end },
    months: snap.pickerMonths,
    today: snap.today,
    currentYm: snap.currentYm,
    rows: snap.allEmployees
      .filter((e) => e.hired <= range.end && (!e.leftOn || e.leftOn >= range.start))
      .map((e) => ({
        emp: brief(e),
        month: monthSummary(snap.ledger.monthOf(e, ym), snap.settings.rounding),
        risk: riskSummary(snap.ledger.riskOf(e, ym)),
        leaveRemaining: snap.ledger.leaveOf(e).remaining,
      })),
  };
  return c.json(body);
});

/**
 * 給与計算用のCSV。kind=summary は社員ごとの月の集計、kind=detail は日別の明細。
 * time=hm は「H:MM」、time=decimal は小数の時間（例 12.50）。給与ソフトごとの取り込み形式には合わせていないので、
 * 取り込み側の項目に合わせて列を並べ替えて使う。
 */
app.get("/api/attendance/export", (c) => {
  requireAdmin(c);
  const snap = attendanceSnapshot(c);
  const ym = ymParam(c, snap);
  const kind = c.req.query("kind") === "detail" ? "detail" : "summary";
  const decimal = c.req.query("time") === "decimal";
  const range = periodOfYm(ym, snap.settings.closingDay);
  const t = (min: number): string => (decimal ? (Math.round((min / 60) * 100) / 100).toFixed(2) : `${Math.floor(Math.round(min) / 60)}:${String(Math.round(min) % 60).padStart(2, "0")}`);
  const clockText = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
  const emps = snap.allEmployees.filter((e) => e.hired <= range.end && (!e.leftOn || e.leftOn >= range.start));
  const rows: (string | number)[][] = [];
  if (kind === "summary") {
    rows.push(["社員ID", "氏名", "部署", "雇用区分", "勤務区分", "対象期間", "出勤日数", "有給日数", "欠勤日数", "要確認日数", "総労働時間", "法定内労働", "時間外労働", "うち週の超過", "うち期間の超過", "深夜労働", "法定休日労働"]);
    for (const e of emps) {
      const m = snap.ledger.monthOf(e, ym);
      const x = monthSummary(m, snap.settings.rounding);
      rows.push([e.id, e.name, e.dept, e.kind, WORK_STYLE_LABEL[e.workStyle], `${range.start}〜${range.end}`, x.workDays, x.leaveDays, x.absentDays, x.incompleteDays, t(x.workMin), t(x.legalInMin), t(x.overtimeMin), t(x.weeklyOvertimeMin), t(x.periodOvertimeMin), t(x.nightMin), t(x.holidayMin)]);
    }
  } else {
    rows.push(["社員ID", "氏名", "日付", "曜日", "区分", "出勤", "退勤", "休憩(分)", "実働", "法定内", "時間外", "深夜", "法定休日", "備考"]);
    for (const e of emps) {
      for (const { plan: p, result: r } of snap.ledger.dayRows(e, ym)) {
        if (p.kind === "off" && !p.note) continue;
        const label = p.kind === "work" ? "出勤" : p.kind === "leave" ? (p.note ?? "有給休暇") : p.kind === "absent" ? "打刻なし" : p.kind === "incomplete" ? "要確認" : (p.note ?? "休み");
        rows.push([
          e.id, e.name, p.date, "日月火水木金土"[dowOf(p.date)]!, label,
          p.start !== undefined ? clockText(p.start) : "", p.kind === "work" && p.end !== undefined ? clockText(p.end) : "",
          p.breaks.reduce((s, b) => s + b.end - b.start, 0) || "",
          r ? t(r.workMin) : "", r ? t(r.legalInMin) : "", r ? t(r.dailyOvertimeMin) : "", r ? t(r.nightMin) : "", r ? t(r.legalHolidayMin) : "",
          p.kind === "work" && p.note ? p.note : p.kind !== "work" && p.kind !== "off" ? (p.note ?? "") : "",
        ]);
      }
    }
  }
  const name = kind === "summary" ? "勤怠集計" : "勤怠明細";
  return c.body(buildCsv(rows), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="attendance-${kind}-${ym}.csv"; filename*=UTF-8''${encodeURIComponent(`${name}_${ym}.csv`)}`,
  });
});

/** 位置情報の確認で気になる打刻があった日（範囲外は out、位置情報なしは unknown）。設定が無効なら空 */
function geoFlagsOf(db: Db, snap: Snapshot, empId: string, range: { start: string; end: string }): Record<string, "out" | "unknown"> {
  if (snap.settings.geoMode === "off") return {};
  const rows = db.prepare("SELECT date, geo FROM punch_events WHERE emp_id = ? AND date >= ? AND date <= ? AND geo IN ('out','unknown')").all(empId, range.start, range.end) as unknown as { date: string; geo: "out" | "unknown" }[];
  const flags: Record<string, "out" | "unknown"> = {};
  for (const r of rows) if (r.geo === "out" || !flags[r.date]) flags[r.date] = r.geo;
  return flags;
}

app.get("/api/attendance/:id", (c) => {
  const { db, clock } = ctx(c);
  const me = c.get("me");
  const id = c.req.param("id");
  if (me.role !== "admin" && me.id !== id) throw new ApiError(403, "他の社員の勤怠は表示できません");
  const snap = attendanceSnapshot(c, [id]);
  const emp = snap.allEmployees.find((e) => e.id === id);
  if (!emp) throw new ApiError(404, "社員が見つかりません");
  const ym = ymParam(c, snap);
  const range = periodOfYm(ym, snap.settings.closingDay);
  const body: AttendanceDetailResponse = {
    emp: { ...brief(emp), weeklyDays: emp.weeklyDays, weeklyHours: emp.weeklyHours, workStyle: emp.workStyle },
    ym,
    range: { from: range.start, to: range.end },
    months: snap.pickerMonths,
    today: snap.today,
    currentYm: snap.currentYm,
    month: monthSummary(snap.ledger.monthOf(emp, ym), snap.settings.rounding),
    period: snap.ledger.monthOf(emp, ym).period,
    geoFlags: geoFlagsOf(db, snap, emp.id, range),
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
  const snap = snapshot(db, clock, me.role === "admin" ? {} : { only: [me.id] });
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
  return c.json(listRequests(db, snapshot(db, clock, me.role === "admin" ? {} : { only: [me.id] }), { status, empId: me.role === "admin" ? undefined : me.id }));
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
  const snap = snapshot(db, clock, { only: [me.id] });
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
    if (decision === "approved") applyApproval(db, snapshot(db, clock, { only: [r.emp_id] }), r, now.ts);
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

