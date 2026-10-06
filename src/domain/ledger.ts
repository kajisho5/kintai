import {
  calcDay,
  calcMonth,
  check36,
  grantDays,
  remainingObligation,
  type DayInput,
  type DayResult,
  type Interval,
  type MonthlyTotals,
} from "../engine";
import { barsFor } from "./bars";
import { addDays, addMonths, datesOfMonth, diffDays, dowOf, fiscalStartYm, monthsBetween } from "./calendar";
import type {
  Calendar,
  DayPlan,
  Employee,
  LeaveInfo,
  LeaveRow,
  MonthData,
  Bar,
  Outlook,
  PunchEvent,
  Risk,
  RiskLevel,
  Shift,
  TodayRow,
} from "./types";

const SCHED_GRACE_MIN = 15;
/** 出勤から退勤までの上限。これを超えて退勤が無い勤務は、日またぎで続いているのではなく打刻漏れとみなす */
export const MAX_SHIFT_MIN = 20 * 60;

interface Derived {
  in?: number;
  out?: number;
  breaks: Interval[];
  openBreak?: number;
}

/** 打刻イベントから 1 日の出退勤・休憩を導出する。同種は後勝ち（修正申請の承認が上書きできる） */
export function deriveDay(events: PunchEvent[]): Derived {
  const d: Derived = { breaks: [] };
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind === "in") d.in = e.min;
    else if (e.kind === "out") d.out = e.min;
    else if (e.kind === "break_start") d.openBreak ??= e.min;
    else if (d.openBreak !== undefined) {
      d.breaks.push({ start: d.openBreak, end: e.min });
      d.openBreak = undefined;
    }
  }
  return d;
}

/** 所定の休憩（予定表示用）。法定の最低休憩に合わせる */
function plannedBreakLen(baseMin: number): number {
  return baseMin >= 480 ? 60 : baseMin > 360 ? 45 : 0;
}

export class Ledger {
  private events = new Map<string, PunchEvent[]>();
  private leaves = new Map<string, Map<string, number>>();
  private monthCache = new Map<string, MonthData>();
  private riskCache = new Map<string, Risk>();

  constructor(
    readonly cal: Calendar,
    events: PunchEvent[],
    leaves: LeaveRow[],
    private readonly opts: { specialClause: boolean; fiscalStartMonth?: number; legalHolidayDow?: number },
  ) {
    for (const e of events) {
      const k = `${e.empId}|${e.date}`;
      const list = this.events.get(k);
      if (list) list.push(e);
      else this.events.set(k, [e]);
    }
    for (const l of leaves) {
      let m = this.leaves.get(l.empId);
      if (!m) this.leaves.set(l.empId, (m = new Map()));
      m.set(l.date, (m.get(l.date) ?? 0) + l.days);
    }
  }

  get today(): string {
    return this.cal.today;
  }

  eventsOf(empId: string, date: string): PunchEvent[] {
    return this.events.get(`${empId}|${date}`) ?? [];
  }

  leaveDaysOn(empId: string, date: string): number {
    return this.leaves.get(empId)?.get(date) ?? 0;
  }

  private get legalDow(): number {
    return this.opts.legalHolidayDow ?? 0;
  }

  /**
   * いま進行中の勤務（日またぎ）の判定。今日の出勤打刻があれば今日。なければ、昨日の勤務が続いている（退勤前）か、
   * 今日に入ってから退勤した場合は昨日の勤務を返す。どちらでもなければ今日。
   */
  shiftFor(empId: string, nowMin: number): Shift & { open: boolean } {
    const today = this.cal.today;
    if (deriveDay(this.eventsOf(empId, today)).in !== undefined) return { date: today, offset: 0, open: false };
    const yesterday = addDays(today, -1);
    const y = deriveDay(this.eventsOf(empId, yesterday));
    if (y.in !== undefined) {
      if (y.out === undefined && 1440 + nowMin - y.in <= MAX_SHIFT_MIN) return { date: yesterday, offset: 1440, open: true };
      if (y.out !== undefined && y.out >= 1440) return { date: yesterday, offset: 1440, open: false };
    }
    return { date: today, offset: 0, open: false };
  }

  private isScheduled(emp: Employee, date: string): boolean {
    return emp.workDays.includes(dowOf(date)) && !this.cal.holidays[date];
  }

  // ------------------------------------------------------------ 日

  planOf(emp: Employee, date: string): DayPlan {
    if (emp.leftOn && date > emp.leftOn) return { date, kind: "off", breaks: [], note: "退職後" };
    const w = dowOf(date);
    const hol = this.cal.holidays[date];
    const leave = this.leaveDaysOn(emp.id, date);
    const d = deriveDay(this.eventsOf(emp.id, date));

    if (d.in !== undefined) {
      if (d.out === undefined) {
        const going = date === addDays(this.cal.today, -1) && this.cal.nowMin !== undefined && 1440 + this.cal.nowMin - d.in <= MAX_SHIFT_MIN;
        return { date, kind: "incomplete", start: d.in, breaks: d.breaks, note: going ? "勤務中（日またぎ）" : "退勤打刻なし" };
      }
      if (d.out < d.in) return { date, kind: "incomplete", start: d.in, breaks: [], note: "打刻の不整合" };
      const breaks = [...d.breaks];
      if (d.openBreak !== undefined) breaks.push({ start: d.openBreak, end: d.out });
      const offDay = w === this.legalDow || !!hol || !emp.workDays.includes(w);
      const note = leave > 0 && leave < 1 ? "半休" : offDay ? (hol ? "祝日出勤" : "休日出勤") : undefined;
      return {
        date,
        kind: "work",
        start: d.in,
        end: d.out,
        breaks,
        isLegalHoliday: w === this.legalDow,
        nextIsLegalHoliday: dowOf(addDays(date, 1)) === this.legalDow,
        note,
      };
    }
    if (leave > 0) return { date, kind: "leave", breaks: [], note: leave < 1 ? "半休" : "有給休暇" };
    if (w === this.legalDow) return { date, kind: "off", breaks: [], note: "法定休日" };
    if (hol) return { date, kind: "off", breaks: [], note: hol };
    if (!emp.workDays.includes(w)) return { date, kind: "off", breaks: [], note: "所定休日" };
    if (date < this.cal.today && date >= emp.hired) return { date, kind: "absent", breaks: [], note: "打刻なし" };
    return { date, kind: "off", breaks: [] };
  }

  // ------------------------------------------------------------ 月

  /** 当月は前日までを集計対象にする（本日分は打刻中のため含めない） */
  monthOf(emp: Employee, ym: string): MonthData {
    const key = `${emp.id}|${ym}`;
    const hit = this.monthCache.get(key);
    if (hit) return hit;
    const plans = datesOfMonth(ym)
      .filter((d) => d < this.cal.today && d >= emp.hired && (!emp.leftOn || d <= emp.leftOn))
      .map((d) => this.planOf(emp, d));
    const worked = plans.filter((p) => p.kind === "work");
    const input = (p: DayPlan): DayInput => ({
      date: p.date,
      work: { start: p.start!, end: p.end! },
      breaks: p.breaks,
      isLegalHoliday: p.isLegalHoliday,
      nextIsLegalHoliday: p.nextIsLegalHoliday,
    });
    const leaveMap = this.leaves.get(emp.id);
    const leaveDays = leaveMap
      ? datesOfMonth(ym)
          .filter((d) => d < this.cal.today)
          .reduce((s, d) => s + (leaveMap.get(d) ?? 0), 0)
      : 0;
    const data: MonthData = {
      ym,
      plans,
      result: calcMonth(worked.map(input)),
      workDays: worked.length,
      leaveDays,
      absentDays: plans.filter((p) => p.kind === "absent").length,
      incompleteDays: plans.filter((p) => p.kind === "incomplete").length,
    };
    this.monthCache.set(key, data);
    return data;
  }

  /** 日別明細: plans と、出勤日の集計結果を突き合わせる */
  dayRows(emp: Employee, ym: string): { plan: DayPlan; result?: DayResult }[] {
    const m = this.monthOf(emp, ym);
    let i = 0;
    return m.plans.map((plan) => ({ plan, result: plan.kind === "work" ? m.result.days[i++] : undefined }));
  }

  private scheduledDays(emp: Employee, ym: string): { elapsed: number; total: number } {
    const all = datesOfMonth(ym).filter((d) => d >= emp.hired && (!emp.leftOn || d <= emp.leftOn) && this.isScheduled(emp, d));
    return { elapsed: all.filter((d) => d < this.cal.today).length, total: all.length };
  }

  outlookOf(emp: Employee, ym: string, fyMonths: string[]): Outlook {
    const m = this.monthOf(emp, ym).result;
    if (ym !== this.cal.today.slice(0, 7)) {
      return { mtdOvertime: m.overtimeMin, projOvertime: m.overtimeMin, holiday: m.legalHolidayMin };
    }
    const { elapsed, total } = this.scheduledDays(emp, ym);
    const prior = fyMonths
      .filter((x) => x < ym)
      .map((x) => this.monthOf(emp, x))
      .filter((x) => x.workDays > 0)
      .slice(-3)
      .map((x) => x.result.overtimeMin);
    const prevAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : m.overtimeMin;
    const extrap = elapsed > 0 ? (m.overtimeMin / elapsed) * total : prevAvg;
    const w = Math.min(1, elapsed / 10);
    return { mtdOvertime: m.overtimeMin, projOvertime: Math.round(w * extrap + (1 - w) * prevAvg), holiday: m.legalHolidayMin };
  }

  riskOf(emp: Employee, ym: string = this.cal.today.slice(0, 7)): Risk {
    const key = `${emp.id}|${ym}`;
    const hit = this.riskCache.get(key);
    if (hit) return hit;
    const months = monthsBetween(fiscalStartYm(`${ym}-01`, this.opts.fiscalStartMonth), ym);
    const outlook = this.outlookOf(emp, ym, months);
    const history: MonthlyTotals[] = months.map((x) => {
      if (x === ym) return { month: x, overtimeMin: outlook.projOvertime, legalHolidayMin: outlook.holiday };
      const r = this.monthOf(emp, x).result;
      return { month: x, overtimeMin: r.overtimeMin, legalHolidayMin: r.legalHolidayMin };
    });
    const alerts = check36(history, { hasSpecialClause: this.opts.specialClause });
    const level: RiskLevel = alerts.some((a) => a.level === "violation") ? "violation" : alerts.length ? "warning" : "ok";
    const risk: Risk = {
      level,
      alerts,
      yearOvertime: history.reduce((s, m) => s + m.overtimeMin, 0),
      over45Count: history.filter((m) => m.overtimeMin > 45 * 60).length,
      outlook,
    };
    this.riskCache.set(key, risk);
    return risk;
  }

  /** 月別の時間外（グラフ用）。当月は累計と見込を併記 */
  overtimeSeries(emp: Employee, upToYm: string): { ym: string; actual: number; proj: number }[] {
    const months = monthsBetween(fiscalStartYm(`${upToYm}-01`, this.opts.fiscalStartMonth), this.cal.today.slice(0, 7));
    return months.map((ym) => {
      const o = this.outlookOf(emp, ym, months);
      return { ym, actual: o.mtdOvertime, proj: o.projOvertime };
    });
  }

  // ------------------------------------------------------------ 本日

  todayRow(emp: Employee, nowMin: number): TodayRow {
    const date = this.cal.today;
    const who = { id: emp.id, name: emp.name, dept: emp.dept, title: emp.title, kind: emp.kind };
    // 日またぎの勤務は、始業日の打刻として記録されている。以降の時刻は始業日の 0:00 基準で計算し、最後に今日基準へ直す
    const shift = this.shiftFor(emp.id, nowMin);
    const off = shift.offset;
    const n = nowMin + off;
    const d = deriveDay(this.eventsOf(emp.id, shift.date));
    const leave = shift.date === date ? this.leaveDaysOn(emp.id, date) : 0;
    const shiftBars = (bars: Bar[]): Bar[] => (off ? bars.map((b) => ({ ...b, from: b.from - off, to: b.to - off })) : bars);

    if (d.in !== undefined) {
      const open = d.out === undefined && d.openBreak !== undefined;
      const breaks = [...d.breaks];
      if (open) breaks.push({ start: d.openBreak!, end: n });
      const status: TodayRow["status"] = d.out !== undefined ? "left" : open ? "break" : "working";
      let bars: Bar[];
      if (status === "left") {
        bars = barsFor(d.in, d.out!, breaks, d.out! + 1);
      } else {
        // 退勤前は所定終了時刻までの予定も帯で示す（休憩未取得なら所定の休憩も差し引く）。半休は所定時間が半分になる
        const sched = emp.baseMin * (leave > 0 && leave < 1 ? 1 - leave : 1);
        const len = plannedBreakLen(sched);
        const planBreaks = [...breaks];
        const bStart = Math.max(720, d.in + 240);
        if (len && breaks.length === 0 && n < bStart + len) planBreaks.push({ start: bStart, end: bStart + len });
        const planEnd = Math.max(n, d.in + sched + (breaks.length ? 0 : len));
        bars = barsFor(d.in, planEnd, planBreaks, n);
      }
      const worked = bars.filter((b) => !b.plan).reduce((s, b) => s + (b.to - b.from), 0);
      return {
        emp: who,
        status,
        note: leave > 0 && leave < 1 ? "半休" : shift.date !== date ? "日またぎ" : undefined,
        start: d.in - off,
        end: d.out !== undefined ? d.out - off : undefined,
        bars: shiftBars(bars),
        workedMin: worked,
      };
    }
    if (leave > 0) return { emp: who, status: "leave", note: leave < 1 ? "半休" : "有給休暇", bars: [], workedMin: 0 };
    const hol = this.cal.holidays[date];
    if (!this.isScheduled(emp, date) || date < emp.hired) {
      return { emp: who, status: "off", note: hol ?? (dowOf(date) === this.legalDow ? "法定休日" : "所定休日"), bars: [], workedMin: 0 };
    }
    return { emp: who, status: nowMin > emp.schedStart + SCHED_GRACE_MIN ? "missing" : "before", bars: [], workedMin: 0 };
  }

  /** 進行中の勤務の集計（打刻途中でも現在時刻までで計算。日またぎなら始業日の勤務として計算） */
  todayResult(emp: Employee, nowMin: number): DayResult {
    const shift = this.shiftFor(emp.id, nowMin);
    const d = deriveDay(this.eventsOf(emp.id, shift.date));
    if (d.in === undefined) return calcDay({ date: shift.date });
    const end = Math.max(d.in, d.out ?? nowMin + shift.offset);
    const breaks = [...d.breaks];
    if (d.openBreak !== undefined) breaks.push({ start: d.openBreak, end });
    return calcDay({
      date: shift.date,
      work: { start: d.in, end },
      breaks,
      isLegalHoliday: dowOf(shift.date) === this.legalDow,
      nextIsLegalHoliday: dowOf(addDays(shift.date, 1)) === this.legalDow,
    });
  }

  // ------------------------------------------------------------ 有給

  leaveOf(emp: Employee): LeaveInfo {
    const today = this.cal.today;
    const who = { id: emp.id, name: emp.name, dept: emp.dept, weeklyDays: emp.weeklyDays, hired: emp.hired };
    const first = addMonths(emp.hired, 6);
    if (first > today) {
      return { emp: who, granted: 0, taken: 0, planned: 0, carry: 0, remaining: 0, nextGrant: first, obligationLeft: 0 };
    }
    let months = 6;
    while (addMonths(emp.hired, months + 12) <= today) months += 12;
    const grantAt = addMonths(emp.hired, months);
    const periodEnd = addMonths(grantAt, 12);
    const granted = grantDays({ monthsOfService: months, weeklyDays: emp.weeklyDays, weeklyHours: emp.weeklyHours, attendanceRate: 0.95 });
    let taken = 0;
    let planned = 0;
    for (const [date, days] of this.leaves.get(emp.id) ?? []) {
      if (date < grantAt || date >= periodEnd) continue;
      if (date <= today) taken += days;
      else planned += days;
    }
    return {
      emp: who,
      granted,
      taken,
      planned,
      carry: emp.carry,
      remaining: Math.max(0, emp.carry + granted - taken),
      lastGrant: grantAt,
      nextGrant: periodEnd,
      periodEnd,
      obligationLeft: remainingObligation(granted, taken),
      daysToDeadline: diffDays(today, periodEnd),
    };
  }
}

/** 直近の付与日（シード生成用。取得状況に依存しない） */
export function lastGrantDate(hired: string, today: string): string | undefined {
  if (addMonths(hired, 6) > today) return undefined;
  let months = 6;
  while (addMonths(hired, months + 12) <= today) months += 12;
  return addMonths(hired, months);
}

