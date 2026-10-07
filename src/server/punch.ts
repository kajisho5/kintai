import { addDays, deriveDay, MAX_SHIFT_MIN, STALE_SHIFT_MIN, ymOfDate, type Employee, type PunchKind, type PunchStateResponse } from "../domain";
import type { Clock } from "./clock";
import { ApiError } from "./context";
import { audit, tx, type Db } from "./db";
import { loadSettings, type Snapshot } from "./repo";

const PUNCH_LABEL: Record<PunchKind, string> = { in: "出勤", out: "退勤", break_start: "休憩開始", break_end: "休憩終了" };

export interface GeoInput {
  lat: number;
  lng: number;
  /** 位置の誤差（メートル） */
  accuracy?: number;
}

export type GeoResult = "in" | "out" | "unknown";

/** 2点間の距離（メートル。球面上の近似） */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 位置の誤差のうち、範囲の判定で許容する上限（メートル）。誤差が大きい端末で、実際は離れていても範囲内になるのを防ぐ */
export const GEO_ACCURACY_ALLOWANCE_M = 100;

/** 打刻場所のどれかの範囲（半径＋位置の誤差。誤差は上限つき）に入っていれば "in" */
export function evaluateGeo(sites: { lat: number; lng: number; radius_m: number }[], geo: GeoInput): GeoResult {
  if (!sites.length) return "unknown";
  const allowance = Math.min(Math.max(geo.accuracy ?? 0, 0), GEO_ACCURACY_ALLOWANCE_M);
  return sites.some((s) => distanceM(s, geo) <= s.radius_m + allowance) ? "in" : "out";
}

/**
 * 打刻を記録する。日またぎの勤務中なら、始業日の勤務への打刻になる（退勤後は翌日の打刻として出勤できる）。
 * source は 'punch'（本人のログイン）または 'kiosk'（共用端末）。位置情報は、会社の設定とソースに応じて判定・記録する。
 */
export function recordPunch(db: Db, clock: Clock, me: Employee, action: PunchKind, opts: { source?: "punch" | "kiosk"; geo?: GeoInput; actor?: string; detail?: Record<string, unknown> } = {}): void {
  const source = opts.source ?? "punch";
  const now = clock.now();
  const min = Math.floor(now.min);
  const settings = loadSettings(db);
  const exempt = (db.prepare("SELECT geo_exempt AS g FROM employees WHERE id = ?").get(me.id) as { g: number } | undefined)?.g === 1;

  // 位置情報の判定（共用端末は、置いてある場所が打刻の場所なので対象外）
  let geo: GeoResult | null = null;
  let sitesCount = 0;
  if (source === "punch" && settings.geoMode !== "off") {
    const sites = db.prepare("SELECT lat, lng, radius_m FROM geo_sites").all() as unknown as { lat: number; lng: number; radius_m: number }[];
    sitesCount = sites.length;
    geo = opts.geo ? evaluateGeo(sites, opts.geo) : "unknown";
    // 制限は出勤だけ。退勤・休憩は、範囲外でも打刻でき、範囲外として記録・表示される（外出先や帰宅後に退勤を押す場合があるため）
    if (settings.geoMode === "enforce" && action === "in" && !exempt && sites.length) {
      if (!opts.geo) throw new ApiError(403, "位置情報を取得できないため、出勤を打刻できません。ブラウザの位置情報の許可を確認してください", "GEO_REQUIRED");
      if (geo === "out") throw new ApiError(403, "勤務地の範囲外のため、出勤を打刻できません", "GEO_OUTSIDE");
    }
  }

  const eventsOn = (date: string) =>
    deriveDay(db.prepare("SELECT emp_id AS empId, date, kind, min, seq FROM punch_events WHERE emp_id = ? AND date = ? ORDER BY seq").all(me.id, date) as never);

  tx(db, () => {
    const yesterday = addDays(now.date, -1);
    const today = eventsOn(now.date);
    const prev = eventsOn(yesterday);
    // 昨日の出勤から退勤していない勤務が続いている（日またぎ）なら、その勤務への打刻とする
    const carrying = today.in === undefined && prev.in !== undefined && prev.out === undefined && 1440 + min - prev.in <= MAX_SHIFT_MIN;
    // 前の勤務が、日またぎとしては長すぎる（退勤の打刻漏れの可能性が高い）なら、新しい出勤を受け付ける。前の勤務は「退勤打刻なし」として残り、修正申請の対象になる
    if (action === "in" && carrying && 1440 + min - (prev.in ?? 0) <= STALE_SHIFT_MIN) throw new ApiError(409, "前の勤務（昨日の出勤）が退勤になっていません。先に退勤を記録してください");
    const carryingNow = carrying && !(action === "in");
    const target = carryingNow ? { date: yesterday, off: 1440, d: prev } : { date: now.date, off: 0, d: today };
    const d = target.d;
    const at = min + target.off;
    if (action === "in" && d.in !== undefined) throw new ApiError(409, "本日はすでに出勤を記録しています");
    if (action !== "in" && d.in === undefined) throw new ApiError(409, "先に出勤を記録してください");
    if (d.out !== undefined) throw new ApiError(409, "本日はすでに退勤を記録しています");
    if (action === "break_start" && d.openBreak !== undefined) throw new ApiError(409, "すでに休憩中です");
    if (action === "break_end" && d.openBreak === undefined) throw new ApiError(409, "休憩を開始していません");
    const ins = db.prepare("INSERT INTO punch_events (emp_id, date, kind, min, source, created_at, lat, lng, accuracy, geo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // 位置情報は、会社が確認を有効にしているときだけ保存する（無効なら、送られてきても捨てる）
    // （打刻場所が1件も登録されていないときは、判定に使わないので、保存しない）
    const stored = geo !== null && sitesCount > 0 ? opts.geo : undefined;
    const put = (kind: PunchKind) => ins.run(me.id, target.date, kind, at, source, now.ts, stored?.lat ?? null, stored?.lng ?? null, stored?.accuracy ?? null, geo);
    // 休憩中の退勤は、休憩を退勤時刻で閉じてから記録する
    if (action === "out" && d.openBreak !== undefined) put("break_end");
    put(action);
    audit(db, now.ts, opts.actor ?? me.id, source === "kiosk" ? "punch_kiosk" : "punch", { emp: me.id, action: PUNCH_LABEL[action], date: target.date, min: at, ...(geo ? { geo } : {}), ...(opts.detail ?? {}) });
  });
}

/** 進行中の勤務の状態（打刻画面・共用端末の表示に使う） */
export function punchState(snap: Snapshot, me: Employee): PunchStateResponse {
  const { ledger } = snap;
  const shift = ledger.shiftFor(me.id, snap.nowMin);
  const day = ledger.todayResult(me, snap.nowMin);
  const d = deriveDay(ledger.eventsOf(me.id, shift.date));
  const ym = snap.currentYm;
  const month = ledger.monthOf(me, ym);
  const risk = ledger.riskOf(me);
  return {
    date: shift.date,
    offsetMin: shift.offset,
    nowMin: snap.nowMin + shift.offset,
    events: { in: d.in, out: d.out, breaks: d.breaks, openBreak: d.openBreak },
    day,
    // 月をまたいで終わる日またぎの勤務は、前の月の勤務として扱うので、今月の累計には足さない
    // 集計済みの月（退勤して日付が変わった勤務）には、すでにこの勤務が入っているので、足さない
    monthOvertimeMin: month.result.overtimeMin + (ymOfDate(shift.date, snap.settings.closingDay) === ym && (shift.date === snap.today || shift.open) ? day.dailyOvertimeMin : 0),
    outlook: risk.outlook,
    riskLevel: risk.level,
    leaveRemaining: ledger.leaveOf(me).remaining,
    geo: geoInfo(snap, me),
    staleShift: shift.open && shift.offset > 0 && 1440 + snap.nowMin - (d.in ?? 0) > STALE_SHIFT_MIN ? true : undefined,
  };
}

function geoInfo(snap: Snapshot, me: Employee): PunchStateResponse["geo"] {
  const mode = snap.settings.geoMode;
  if (mode === "off") return { mode: "off", required: false };
  return { mode, required: mode === "enforce" && !me.geoExempt && snap.geoSiteCount > 0 };
}

