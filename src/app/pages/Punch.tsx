import { useState } from "react";
import { Coffee, LogIn, LogOut, Play } from "lucide-react";
import { api, useApi } from "../api";
import type { PunchStateResponse } from "../../domain/api";
import { clock as fmtClock, dur, durOrDash, jpDate } from "../format";
import { useClock, useSession } from "../session";
import { Gauge, Pill, RiskPill } from "../ui/kit";

type Act = "in" | "out" | "break_start" | "break_end";

/** 現在地（打刻の確認用）。許可がない・取得できないときは失敗する */
function currentPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("位置情報に対応していません"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.message)),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}
const LABEL: Record<Act, string> = { in: "出勤", out: "退勤", break_start: "休憩開始", break_end: "休憩終了" };

export function Punch() {
  const { me, refresh } = useSession();
  const now = useClock();
  const { data, error, reload } = useApi<PunchStateResponse>("/api/punch/today");
  const [state, setState] = useState<PunchStateResponse | undefined>();
  const [toast, setToast] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const s = state ?? data;
  if (!s) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;
  const ev = s.events;

  const onBreak = ev.openBreak !== undefined;
  const phase = ev.in === undefined ? "before" : ev.out !== undefined ? "done" : onBreak ? "break" : "working";
  const enabled: Record<Act, boolean> = {
    // 日またぎの勤務を退勤したあとの表示でも、次の勤務の出勤は押せる
    in: phase === "before" || (phase === "done" && s.offsetMin > 0),
    break_start: phase === "working",
    break_end: phase === "break",
    out: phase === "working" || phase === "break",
  };

  const stamp = async (a: Act) => {
    setBusy(true);
    setErr("");
    try {
      // 位置情報の確認が有効なら、打刻の瞬間の位置を送る（取得できなくても、制限モードでなければ打刻は止まらない）
      const geo = s.geo.mode === "off" ? undefined : await currentPosition().catch(() => undefined);
      if (s.geo.required && !geo) throw new Error("位置情報を取得できません。ブラウザの位置情報の許可を確認してください");
      // 時刻はサーバーが記録する（端末の時計は使わない）
      const next = await api<PunchStateResponse>("/api/punch", { method: "POST", body: { action: a, geo } });
      setState(next);
      const t = a === "in" ? next.events.in : a === "out" ? next.events.out : a === "break_start" ? next.events.openBreak : next.events.breaks[next.events.breaks.length - 1]?.end;
      setToast(`${LABEL[a]}を記録しました${t !== undefined ? `（${fmtClock(t)}）` : ""}`);
      refresh();
    } catch (e) {
      setToast("");
      setErr(e instanceof Error ? e.message : "打刻に失敗しました");
      reload();
      setState(undefined);
    } finally {
      setBusy(false);
    }
  };

  const last = (a: Act): string => {
    if (a === "in") return ev.in !== undefined ? `記録済み ${fmtClock(ev.in)}` : "勤務を開始";
    if (a === "out") return ev.out !== undefined ? `記録済み ${fmtClock(ev.out)}` : "勤務を終了";
    if (a === "break_start") {
      const open = ev.openBreak ?? ev.breaks[ev.breaks.length - 1]?.start;
      return open !== undefined ? `直近 ${fmtClock(open)}` : "休憩に入る";
    }
    const b = ev.breaks[ev.breaks.length - 1];
    return b ? `直近 ${fmtClock(b.end)}` : "休憩から戻る";
  };

  const statusPill =
    phase === "before" ? <Pill>出勤前</Pill> : phase === "working" ? <Pill tone="live">勤務中</Pill> : phase === "break" ? <Pill tone="warn">休憩中</Pill> : <Pill tone="ai">退勤済</Pill>;

  const timeline: { t: number; label: string; kind: string }[] = [];
  if (ev.in !== undefined) timeline.push({ t: ev.in, label: "出勤", kind: "in" });
  ev.breaks.forEach((b) => {
    timeline.push({ t: b.start, label: "休憩開始", kind: "brk" });
    timeline.push({ t: b.end, label: "休憩終了", kind: "brk" });
  });
  if (ev.openBreak !== undefined) timeline.push({ t: ev.openBreak, label: "休憩開始", kind: "brk" });
  if (ev.out !== undefined) timeline.push({ t: ev.out, label: "退勤", kind: "out" });
  timeline.sort((a, b) => a.t - b.t);

  const carried = s.offsetMin > 0;
  const elapsed = ev.in === undefined ? "" : `出勤から ${dur((ev.out ?? now.min + s.offsetMin) - ev.in)} 経過`;
  const monthOt = s.monthOvertimeMin;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>打刻</h1>
          <p>{me.employee.name}さん（{me.employee.dept}）</p>
        </div>
      </header>

      <div className="punch">
        <section className="panel" aria-label="打刻">
          <div className="clockface">
            <span className="status">{statusPill}</span>
            <div className="big num" aria-label={`現在時刻 ${now.hh}時${now.mm}分`}>
              {now.hh}:{now.mm}
              <span className="sec" aria-hidden="true">{now.ss}</span>
            </div>
            <div className="date">{jpDate(now.today)}</div>
            <div className="elapsed">{elapsed}</div>
          </div>
          <div className="punch-actions">
            <button type="button" className="pbtn main-act" disabled={!enabled.in || busy} onClick={() => stamp("in")}>
              <span className="ic"><LogIn size={20} /></span>
              <span><b>出勤</b><small>{last("in")}</small></span>
            </button>
            <button type="button" className="pbtn main-act" disabled={!enabled.out || busy} onClick={() => stamp("out")}>
              <span className="ic"><LogOut size={20} /></span>
              <span><b>退勤</b><small>{last("out")}</small></span>
            </button>
            <button type="button" className="pbtn" disabled={!enabled.break_start || busy} onClick={() => stamp("break_start")}>
              <span className="ic"><Coffee size={20} /></span>
              <span><b>休憩開始</b><small>{last("break_start")}</small></span>
            </button>
            <button type="button" className="pbtn" disabled={!enabled.break_end || busy} onClick={() => stamp("break_end")}>
              <span className="ic"><Play size={20} /></span>
              <span><b>休憩終了</b><small>{last("break_end")}</small></span>
            </button>
          </div>
          {s.geo.mode !== "off" ? (
            <p className="note" style={{ textAlign: "center", margin: "0 16px 8px" }}>
              打刻の確認のため、打刻の瞬間の位置情報を使います{s.geo.required ? "（打刻には位置情報の許可が必要です）" : "（許可しなくても打刻できます）"}。位置情報は、勤務場所の確認にだけ使います。
            </p>
          ) : null}
          <div className="toast" role="status" aria-live="polite">{toast}</div>
          {err ? <div className="form-error" role="alert" style={{ textAlign: "center", paddingBottom: 16 }}>{err}</div> : null}
        </section>

        <div className="stack">
          <section className="panel" aria-labelledby="rec">
            <div className="panel-head"><h2 id="rec">{carried ? "日またぎの勤務の記録" : "本日の記録"}</h2></div>
            {carried ? <p className="note" style={{ margin: "10px 20px 0" }}>{jpDate(s.date)}に出勤した勤務です。25:00のように、翌日の時刻は24時以降で表示します。</p> : null}
            {timeline.length === 0 ? (
              <div className="empty"><b>まだ打刻がありません</b>「出勤」を押すと記録が始まります。</div>
            ) : (
              <ol className="timeline">
                {timeline.map((t, i) => (
                  <li key={i} className={t.kind}>
                    <span className="num">{fmtClock(t.t)}</span>
                    <span>{t.label}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="panel" aria-labelledby="sum">
            <div className="panel-head"><h2 id="sum">{carried ? "この勤務の集計" : "本日の集計"}</h2></div>
            <div className="panel-body">
              <dl className="kv">
                <div><dt>実働</dt><dd>{durOrDash(s.day.workMin)}</dd></div>
                <div><dt>法定内</dt><dd>{durOrDash(s.day.legalInMin)}</dd></div>
                <div><dt>時間外</dt><dd>{durOrDash(s.day.dailyOvertimeMin)}</dd></div>
                <div><dt>深夜（22:00〜5:00）</dt><dd>{durOrDash(s.day.nightMin)}</dd></div>
              </dl>
              <p className="note">打刻した時点までの集計です。</p>
            </div>
          </section>

          <section className="panel" aria-labelledby="mon">
            <div className="panel-head">
              <h2 id="mon">今月の時間外</h2>
              <RiskPill level={s.riskLevel} />
            </div>
            <div className="panel-body">
              <div className="gauge-cell">
                <Gauge mtd={monthOt} proj={Math.max(s.outlook.projOvertime, monthOt)} scaleHours={60} tickHours={45} level={s.riskLevel} />
                <span className="num">{dur(monthOt)}</span>
              </div>
              <div className="gauge-scale"><span>0</span><span>45時間</span><span>60時間</span></div>
              <p className="note">月末見込は {dur(s.outlook.projOvertime)} です。有給の残りは {s.leaveRemaining} 日です。</p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
