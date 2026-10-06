import {
  LEGAL_WEEKLY_MIN,
  LIMITS_STANDARD,
  LIMITS_YEARLY_VARIABLE,
  calcDay,
  calcFlexPeriod,
  calcVariablePeriod,
  check36,
  grantDays,
  remainingObligation,
  weekStart,
  type DayInput,
  type DayResult,
  type Interval,
  type MonthResult,
  type MonthlyTotals,
  type PeriodDayInput,
  type PeriodDayResult,
  type PeriodResult,
} from "../engine";
import { barsFor } from "./bars";
import { addDays, addMonths, datesBetween, datesOfPeriod, diffDays, dowOf, fiscalStartYm, flexPeriodOfYm, monthsBetween, periodOfYm, yearlyPeriodOfYm, ymOfDate } from "./calendar";
import type {
  Calendar,
  DayPlan,
  Employee,
  LedgerOptions,
  LeaveInfo,
  LeaveRow,
  MonthData,
  Bar,
  Outlook,
  PeriodInfo,
  PunchEvent,
  Risk,
  RiskLevel,
  ScheduleRow,
  Shift,
  TodayRow,
} from "./types";

const SCHED_GRACE_MIN = 15;
/** 出勤率を実績から判定できないときに仮定する値（8割以上） */
const ASSUMED_ATTENDANCE_RATE = 0.95;
/** 出勤から退勤までの上限。これを超えて退勤が無い勤務は、日またぎで続いているのではなく打刻漏れとみなす */
export const MAX_SHIFT_MIN = 20 * 60;
/** 日またぎの勤務を退勤したあと、その勤務を「退勤済み」として表示し続ける時間 */
export const CLOSED_SHIFT_DISPLAY_MIN = 12 * 60;
/** 退勤の無い勤務が、これを超えて続いているときは、日またぎではなく退勤の打刻漏れの可能性が高いとして、新しい出勤も受け付ける */
export const STALE_SHIFT_MIN = 12 * 60;

interface PeriodComputed {
  per: { start: string; end: string };
  dates: string[];
  result: PeriodResult;
  byDate: Map<string, PeriodDayResult>;
}

interface Derived {
  in?: number;
  out?: number;
  breaks: Interval[];
  openBreak?: number;
}

/** 打刻イベントから 1 日の出退勤・休憩を導出する。同種は後勝ち（修正申請の承認が上書きできる） */
export function deriveDay(events: PunchEvent[]): Derived {
  const d: Derived = { breaks: [] };
  // 読み込み済みの打刻は、記録順に並んでいる。並んでいなければ（テストの入力など）、並べ替える
  let sorted = true;
  for (let i = 1; i < events.length; i++) {
    if (events[i - 1]!.seq > events[i]!.seq) {
      sorted = false;
      break;
    }
  }
  for (const e of sorted ? events : [...events].sort((a, b) => a.seq - b.seq)) {
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
  private schedules = new Map<string, ScheduleRow>();
  /** シフトを1件でも持つ社員（持たない社員は、法定休日の判定を曜日だけで済ませる） */
  private scheduled = new Set<string>();
  /** 社員×週（日曜始まり）ごとの、シフトで指定した法定休日（指定がなければ null） */
  private legalOfWeek = new Map<string, string | null>();
  private periodCache = new Map<string, PeriodComputed>();
  private planCache = new Map<string, DayPlan>();

  constructor(
    readonly cal: Calendar,
    events: PunchEvent[],
    leaves: LeaveRow[],
    private readonly opts: LedgerOptions,
  ) {
    for (const r of opts.schedules ?? []) {
      this.schedules.set(`${r.empId}|${r.date}`, r);
      this.scheduled.add(r.empId);
    }
    // 同じ社員・日付の行が続いていれば、キーの作成・検索を省く（読み込みは、社員・日付の順に並んでいる）
    let lastEmp = "";
    let lastDate = "";
    let last: PunchEvent[] | undefined;
    for (const e of events) {
      if (last && e.empId === lastEmp && e.date === lastDate) {
        last.push(e);
        continue;
      }
      const k = `${e.empId}|${e.date}`;
      let list = this.events.get(k);
      if (!list) this.events.set(k, (list = []));
      list.push(e);
      last = list;
      lastEmp = e.empId;
      lastDate = e.date;
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

  private get closing(): number {
    return this.opts.closingDay ?? 0;
  }

  /** 今日が属する月（締め日があれば、締め日の翌日以降は翌月分） */
  get currentYm(): string {
    return ymOfDate(this.cal.today, this.closing);
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
      // 今日に入ってから退勤した勤務は、退勤から半日のあいだ「退勤済み」として表示する（その後は次の勤務の出勤前として扱う）
      if (y.out !== undefined && y.out >= 1440 && nowMin - (y.out - 1440) <= CLOSED_SHIFT_DISPLAY_MIN) return { date: yesterday, offset: 1440, open: false };
    }
    return { date: today, offset: 0, open: false };
  }

  scheduleOf(empId: string, date: string): ScheduleRow | undefined {
    return this.schedules.get(`${empId}|${date}`);
  }

  /** その日の勤務予定。シフトがあればそれ、なければ通常の週の予定（所定労働日・祝日を除く）。休みなら undefined */
  plannedShift(emp: Employee, date: string): { start: number; end: number; breakMin: number; workMin: number } | undefined {
    const row = this.scheduleOf(emp.id, date);
    if (row) {
      return row.kind === "work" ? { start: row.start!, end: row.end!, breakMin: row.breakMin, workMin: row.end! - row.start! - row.breakMin } : undefined;
    }
    if (!emp.workDays.includes(dowOf(date)) || this.cal.holidays[date]) return undefined;
    const breakMin = plannedBreakLen(emp.baseMin);
    return { start: emp.schedStart, end: emp.schedStart + emp.baseMin + breakMin, breakMin, workMin: emp.baseMin };
  }

  private isScheduled(emp: Employee, date: string): boolean {
    return this.plannedShift(emp, date) !== undefined;
  }

  /**
   * 法定休日か。シフトで法定休日を指定した週（日曜始まりの暦週）は、指定した日だけが法定休日。
   * 指定がなければ、会社の設定の曜日（既定は日曜）。
   */
  isLegalHoliday(emp: Employee, date: string): boolean {
    if (this.scheduled.has(emp.id)) {
      const ws = weekStart(date, 0);
      const key = `${emp.id}|${ws}`;
      let designated = this.legalOfWeek.get(key);
      if (designated === undefined) {
        designated = null;
        for (let i = 0; i < 7; i++) {
          const d = addDays(ws, i);
          if (this.scheduleOf(emp.id, d)?.kind === "legal_off") {
            designated = d;
            break;
          }
        }
        this.legalOfWeek.set(key, designated);
      }
      if (designated !== null) return designated === date;
    }
    return dowOf(date) === this.legalDow;
  }

  /**
   * 週の法定労働時間。特例措置対象事業場の週44時間は、通常の勤務・1か月単位の変形・清算期間が1か月以内のフレックスに限る
   * （労基則25条の2）。1年単位の変形・1週間単位の変形・清算期間が1か月を超えるフレックスは、週40時間。
   */
  private weeklyLegalMinFor(emp: Employee): number {
    const special = this.opts.weeklyLegalMin ?? LEGAL_WEEKLY_MIN;
    if (emp.workStyle === "yearly" || emp.workStyle === "weekly") return LEGAL_WEEKLY_MIN;
    if (emp.workStyle === "flex" && (this.opts.flexMonths ?? 1) > 1) return LEGAL_WEEKLY_MIN;
    return special;
  }

  // ------------------------------------------------------------ 日

  /** 1日分の予定・実績。この Ledger のデータは変わらないので、結果を使い回す */
  planOf(emp: Employee, date: string): DayPlan {
    const key = `${emp.id}|${date}`;
    let p = this.planCache.get(key);
    if (!p) this.planCache.set(key, (p = this.computePlan(emp, date)));
    return p;
  }

  private computePlan(emp: Employee, date: string): DayPlan {
    if (emp.leftOn && date > emp.leftOn) return { date, kind: "off", breaks: [], note: "退職後" };
    const hol = this.cal.holidays[date];
    const leave = this.leaveDaysOn(emp.id, date);
    const d = deriveDay(this.eventsOf(emp.id, date));
    const legal = this.isLegalHoliday(emp, date);
    const row = this.scheduleOf(emp.id, date);

    if (d.in !== undefined) {
      if (d.out === undefined) {
        const going = date === addDays(this.cal.today, -1) && this.cal.nowMin !== undefined && 1440 + this.cal.nowMin - d.in <= MAX_SHIFT_MIN;
        return { date, kind: "incomplete", start: d.in, breaks: d.breaks, note: going ? "勤務中（日またぎ）" : "退勤打刻なし" };
      }
      if (d.out < d.in) return { date, kind: "incomplete", start: d.in, breaks: [], note: "打刻の不整合" };
      const breaks = [...d.breaks];
      if (d.openBreak !== undefined) breaks.push({ start: d.openBreak, end: d.out });
      const offDay = legal || !this.isScheduled(emp, date);
      const core = emp.workStyle === "flex" ? this.opts.flexCore : undefined;
      const note =
        leave > 0 && leave < 1
          ? "半休"
          : offDay
            ? hol
              ? "祝日出勤"
              : "休日出勤"
            : core && (d.in > core.start || d.out < core.end)
              ? "コアタイム外"
              : undefined;
      return {
        date,
        kind: "work",
        start: d.in,
        end: d.out,
        breaks,
        isLegalHoliday: legal,
        nextIsLegalHoliday: this.isLegalHoliday(emp, addDays(date, 1)),
        note,
      };
    }
    if (leave > 0) return { date, kind: "leave", breaks: [], note: leave < 1 ? "半休" : "有給休暇" };
    if (legal && !(row && row.kind === "work")) return { date, kind: "off", breaks: [], note: "法定休日" };
    if (hol && !row) return { date, kind: "off", breaks: [], note: hol };
    if (!this.isScheduled(emp, date)) return { date, kind: "off", breaks: [], note: row ? "休み" : "所定休日" };
    if (date < this.cal.today && date >= emp.hired) return { date, kind: "absent", breaks: [], note: "打刻なし" };
    return { date, kind: "off", breaks: [] };
  }

  // ------------------------------------------------------------ 月

  /** 当月は前日までを集計対象にする（本日分は打刻中のため含めない） */
  monthOf(emp: Employee, ym: string): MonthData {
    const key = `${emp.id}|${ym}`;
    const hit = this.monthCache.get(key);
    if (hit) return hit;
    const plans = datesOfPeriod(ym, this.closing)
      .filter((d) => d < this.cal.today && d >= emp.hired && (!emp.leftOn || d <= emp.leftOn))
      .map((d) => this.planOf(emp, d));
    const worked = plans.filter((p) => p.kind === "work");
    const leaveMap = this.leaves.get(emp.id);
    const leaveDays = leaveMap
      ? datesOfPeriod(ym, this.closing)
          .filter((d) => d < this.cal.today)
          .reduce((s, d) => s + (leaveMap.get(d) ?? 0), 0)
      : 0;

    // 週をまたぐ月の区切り（締め日・月初・月末）でも、週の判定が途切れないよう、月の前後の週も含めた期間で計算する。
    // 時間外は「発生した日」に付くので、その月の勤務日の分を合計すれば、月の時間外になる
    const comp = this.periodComputed(emp, this.periodOf(emp, ym));
    const days = worked.map((p) => comp.byDate.get(p.date)!).map((d) => ({ ...d, dailyOvertimeMin: d.overtimeMin }));
    const sum = (f: (d: PeriodDayResult) => number) => days.reduce((n, d) => n + f(d), 0);
    const overtimeMin = sum((d) => d.overtimeMin);
    const result: MonthResult = {
      days,
      workMin: sum((d) => d.workMin),
      overtimeMin,
      weeklyOvertimeMin: sum((d) => d.weeklyOvertimeMin),
      periodOvertimeMin: sum((d) => d.periodOvertimeMin),
      legalHolidayMin: sum((d) => d.legalHolidayMin),
      nightMin: sum((d) => d.nightMin),
      overtimeOver60hMin: Math.max(0, overtimeMin - 60 * 60),
    };
    const period: PeriodInfo | undefined = emp.workStyle === "fixed" || emp.workStyle === "weekly" ? undefined : this.periodInfo(emp, comp);
    const data: MonthData = {
      ym,
      period,
      plans,
      result,
      workDays: worked.length,
      leaveDays,
      absentDays: plans.filter((p) => p.kind === "absent").length,
      incompleteDays: plans.filter((p) => p.kind === "incomplete").length,
    };
    this.monthCache.set(key, data);
    return data;
  }

  // ---- 変形労働時間制・フレックスタイム制の期間 ----

  /** 月 ym を含む変形期間・清算期間。1週間単位は、その月にかかる週をすべて含める */
  private periodOf(emp: Employee, ym: string): { start: string; end: string } {
    switch (emp.workStyle) {
      case "yearly":
        return yearlyPeriodOfYm(ym, this.opts.yearlyStartMonth ?? 4, this.closing);
      case "flex":
        return flexPeriodOfYm(ym, this.opts.flexStartMonth ?? 4, this.opts.flexMonths ?? 1, this.closing);
      case "weekly": {
        const p = periodOfYm(ym, this.closing);
        return { start: weekStart(p.start, 1), end: addDays(weekStart(p.end, 1), 6) };
      }
      case "monthly":
        return periodOfYm(ym, this.closing);
      default: {
        // 通常の勤務: 月の前後の週も含める（週の判定が、月の区切りで途切れないように）
        const p = periodOfYm(ym, this.closing);
        return { start: weekStart(p.start, 1), end: addDays(weekStart(p.end, 1), 6) };
      }
    }
  }

  /** 期間内の1日分の入力。本日以降は勤務の実績なし（予定の所定労働時間だけを持つ） */
  private periodInput(emp: Employee, date: string): PeriodDayInput {
    const p = date < this.cal.today ? this.planOf(emp, date) : undefined;
    return {
      date,
      work: p?.kind === "work" ? { start: p.start!, end: p.end! } : undefined,
      breaks: p?.kind === "work" ? p.breaks : undefined,
      isLegalHoliday: this.isLegalHoliday(emp, date),
      nextIsLegalHoliday: this.isLegalHoliday(emp, addDays(date, 1)),
      // 通常の勤務は、日8時間・週40時間の固定のしきい値で判定する（シフトの所定時間は使わない）
      scheduledMin: emp.workStyle === "fixed" ? undefined : (this.plannedShift(emp, date)?.workMin ?? 0),
    };
  }

  private computePeriod(emp: Employee, inputs: PeriodDayInput[]): PeriodResult {
    const weeklyLegalMin = this.weeklyLegalMinFor(emp);
    if (emp.workStyle === "flex") return calcFlexPeriod(inputs, { weeklyLegalMin, groupOf: (d) => ymOfDate(d, this.closing), multiMonth: (this.opts.flexMonths ?? 1) > 1 });
    if (emp.workStyle === "fixed") return calcVariablePeriod(inputs, { weeklyLegalMin, periodLimit: false });
    if (emp.workStyle !== "weekly") return calcVariablePeriod(inputs, { weeklyLegalMin });
    // 1週間単位: 週ごとに独立して計算する
    const days: PeriodDayResult[] = [];
    let frameMin = 0;
    let ordinaryMin = 0;
    for (let i = 0; i < inputs.length; ) {
      const wk = weekStart(inputs[i]!.date, 1);
      let j = i;
      while (j < inputs.length && weekStart(inputs[j]!.date, 1) === wk) j++;
      const r = calcVariablePeriod(inputs.slice(i, j), { weeklyLegalMin });
      days.push(...r.days);
      frameMin += r.frameMin;
      ordinaryMin += r.ordinaryMin;
      i = j;
    }
    return { days, frameMin, ordinaryMin };
  }

  private periodComputed(emp: Employee, per: { start: string; end: string }): PeriodComputed {
    const key = `${emp.id}|${emp.workStyle}|${per.start}`;
    const hit = this.periodCache.get(key);
    if (hit) return hit;
    // 入社日より前・退職日より後は、期間に含めない（総枠は在籍した日数で按分される）
    // （通常の勤務は、週の判定のため、在籍前後の日も含める。その日に勤務の実績はない）
    const clip = emp.workStyle !== "fixed";
    const from = clip && per.start < emp.hired ? emp.hired : per.start;
    const to = clip && emp.leftOn && emp.leftOn < per.end ? emp.leftOn : per.end;
    const dates = from <= to ? datesBetween(from, to) : [];
    const result = this.computePeriod(emp, dates.map((d) => this.periodInput(emp, d)));
    const byDate = new Map(dates.map((d, i) => [d, result.days[i]!]));
    const comp: PeriodComputed = { per, dates, result, byDate };
    this.periodCache.set(key, comp);
    return comp;
  }

  private periodInfo(emp: Employee, comp: PeriodComputed): PeriodInfo {
    const today = this.cal.today;
    let contractMin = 0;
    let contractSoFarMin = 0;
    for (const d of comp.dates) {
      const s = this.plannedShift(emp, d)?.workMin ?? 0;
      contractMin += s;
      if (d < today) contractSoFarMin += s;
    }
    return {
      style: emp.workStyle,
      start: comp.per.start,
      end: comp.per.end,
      frameMin: comp.result.frameMin,
      workMin: comp.result.ordinaryMin,
      contractMin,
      contractSoFarMin,
      overtimeMin: comp.result.days.reduce((s, d) => s + d.overtimeMin, 0),
      remainingDays: comp.dates.filter((d) => d >= today).length,
    };
  }

  /**
   * 変形労働時間制・フレックスタイム制の月末見込。これまでの実績が所定の何倍だったか（ペース）を、これからの所定労働時間に掛けて、
   * 残りの日が同じペースで働かれたものとして期間を計算し直し、その月の時間外を求める。
   */
  private projectedOvertime(emp: Employee, ym: string): number {
    const comp = this.periodComputed(emp, this.periodOf(emp, ym));
    const today = this.cal.today;
    let sched = 0;
    let actual = 0;
    let workedDays = 0;
    for (const d of comp.dates) {
      if (d >= today) break;
      const day = comp.byDate.get(d)!;
      if (day.workMin - day.legalHolidayMin > 0) workedDays++;
      actual += day.workMin - day.legalHolidayMin;
      sched += this.plannedShift(emp, d)?.workMin ?? 0;
    }
    const ratio = workedDays >= 3 && sched > 0 ? Math.min(1.6, Math.max(0.7, actual / sched)) : 1;
    const inputs = comp.dates.map((d) => {
      const base = this.periodInput(emp, d);
      if (d < today) return base;
      const plan = this.plannedShift(emp, d);
      if (!plan) return base;
      const len = Math.round(plan.workMin * ratio);
      return { ...base, work: { start: plan.start, end: plan.start + len + plan.breakMin }, breaks: plan.breakMin ? [{ start: plan.start + 240, end: plan.start + 240 + plan.breakMin }] : undefined };
    });
    const r = this.computePeriod(emp, inputs);
    return comp.dates.reduce((s, d, i) => (ymOfDate(d, this.closing) === ym ? s + r.days[i]!.overtimeMin : s), 0);
  }

  /** 日別明細: plans と、出勤日の集計結果を突き合わせる */
  dayRows(emp: Employee, ym: string): { plan: DayPlan; result?: DayResult }[] {
    const m = this.monthOf(emp, ym);
    let i = 0;
    return m.plans.map((plan) => ({ plan, result: plan.kind === "work" ? m.result.days[i++] : undefined }));
  }

  private scheduledDays(emp: Employee, ym: string): { elapsed: number; total: number } {
    const all = datesOfPeriod(ym, this.closing).filter((d) => d >= emp.hired && (!emp.leftOn || d <= emp.leftOn) && this.isScheduled(emp, d));
    return { elapsed: all.filter((d) => d < this.cal.today).length, total: all.length };
  }

  outlookOf(emp: Employee, ym: string, fyMonths: string[]): Outlook {
    const m = this.monthOf(emp, ym).result;
    if (ym !== this.currentYm) {
      return { mtdOvertime: m.overtimeMin, projOvertime: m.overtimeMin, holiday: m.legalHolidayMin };
    }
    if (emp.workStyle !== "fixed") {
      // 変形労働時間制・フレックスタイム制: 日・週・期間の判定を残りの予定まで含めて計算し直す
      return { mtdOvertime: m.overtimeMin, projOvertime: Math.max(m.overtimeMin, this.projectedOvertime(emp, ym)), holiday: m.legalHolidayMin };
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

  riskOf(emp: Employee, ym: string = this.currentYm): Risk {
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
    // 対象期間が3か月を超える1年単位の変形労働時間制は、限度時間が月42時間・年320時間になる
    const limits = emp.workStyle === "yearly" ? LIMITS_YEARLY_VARIABLE : LIMITS_STANDARD;
    const alerts = check36(history, { hasSpecialClause: this.opts.specialClause, limits });
    const level: RiskLevel = alerts.some((a) => a.level === "violation") ? "violation" : alerts.length ? "warning" : "ok";
    const risk: Risk = {
      level,
      alerts,
      yearOvertime: history.reduce((s, m) => s + m.overtimeMin, 0),
      over45Count: history.filter((m) => m.overtimeMin > limits.monthMin).length,
      outlook,
    };
    this.riskCache.set(key, risk);
    return risk;
  }

  /** 月別の時間外（グラフ用）。当月は累計と見込を併記 */
  overtimeSeries(emp: Employee, upToYm: string): { ym: string; actual: number; proj: number }[] {
    const months = monthsBetween(fiscalStartYm(`${upToYm}-01`, this.opts.fiscalStartMonth), this.currentYm);
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
    const planned = this.plannedShift(emp, shift.date);
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
        const half = leave > 0 && leave < 1;
        const sched = (planned?.workMin ?? emp.baseMin) * (half ? 1 - leave : 1);
        const len = planned && !half ? planned.breakMin : plannedBreakLen(sched);
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
      return { emp: who, status: "off", note: hol ?? (this.isLegalHoliday(emp, date) ? "法定休日" : "所定休日"), bars: [], workedMin: 0 };
    }
    const start = this.plannedShift(emp, date)?.start ?? emp.schedStart;
    return { emp: who, status: nowMin > start + SCHED_GRACE_MIN ? "missing" : "before", bars: [], workedMin: 0 };
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
      isLegalHoliday: this.isLegalHoliday(emp, shift.date),
      nextIsLegalHoliday: this.isLegalHoliday(emp, addDays(shift.date, 1)),
    });
  }

  // ------------------------------------------------------------ 有給

  /**
   * 出勤率 = 期間の全労働日（所定労働日）のうち、出勤した日（有給休暇の日を含む）の割合。
   * 所定労働日は、シフトまたは通常の週の予定で決める。業務上の傷病・産休・育休などで休んだ日の出勤扱いは、扱わない。
   * 期間が、打刻の記録のある期間より前にかかる場合や、所定労働日が無い場合は、判定できない（undefined）。
   */
  private attendanceRateOf(emp: Employee, from: string, to: string): number | undefined {
    const { workedDatesOf, dataFrom } = this.opts;
    if (!workedDatesOf || !dataFrom || from < dataFrom) return undefined;
    const scheduled = datesBetween(from, addDays(to, -1)).filter((d) => d >= emp.hired && this.isScheduled(emp, d));
    if (!scheduled.length) return undefined;
    const worked = workedDatesOf(emp.id, from, to);
    return scheduled.filter((d) => worked.has(d) || this.leaveDaysOn(emp.id, d) > 0).length / scheduled.length;
  }

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
    // 付与の条件の出勤率は、直前の付与日（初回は入社日）からの期間で判定する。実績から判定できなければ、8割以上と仮定する
    const rate = this.attendanceRateOf(emp, months === 6 ? emp.hired : addMonths(emp.hired, months - 12), grantAt);
    const granted = grantDays({ monthsOfService: months, weeklyDays: emp.weeklyDays, weeklyHours: emp.weeklyHours, attendanceRate: rate ?? ASSUMED_ATTENDANCE_RATE });
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
      attendanceRate: rate,
      rateAssumed: rate === undefined,
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

