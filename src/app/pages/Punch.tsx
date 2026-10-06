import { useState } from "react";
import { Coffee, LogIn, LogOut, Play } from "lucide-react";
import { CURRENT_YM, ME, TODAY, leaveOf, meToday, monthOf, outlookOf, riskOf } from "../data";
import { clock, dur, durOrDash, jpDate } from "../format";
import { actions, useStore } from "../store";
import { useNow } from "../ui/hooks";
import { Gauge, Pill, RiskPill } from "../ui/kit";

type Act = "in" | "bstart" | "bend" | "out";

export function Punch() {
  const { date, min } = useNow();
  const { punch } = useStore();
  const [toast, setToast] = useState("");
  const ev = punch.events;

  const onBreak = ev.breaks.some((b) => b.end === undefined);
  const phase = ev.in === undefined ? "before" : ev.out !== undefined ? "done" : onBreak ? "break" : "working";
  const enabled: Record<Act, boolean> = {
    in: phase === "before",
    bstart: phase === "working",
    bend: phase === "break",
    out: phase === "working" || phase === "break",
  };

  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");

  const stamp = (a: Act) => {
    const m = Math.floor(min);
    const t = clock(m);
    if (a === "in") actions.clockIn(m);
    if (a === "bstart") actions.breakStart(m);
    if (a === "bend") actions.breakEnd(m);
    if (a === "out") actions.clockOut(m);
    const label = { in: "出勤", bstart: "休憩開始", bend: "休憩終了", out: "退勤" }[a];
    setToast(`${label}を記録しました（${t}）`);
  };

  const last = (a: Act): string => {
    if (a === "in") return ev.in !== undefined ? `記録済み ${clock(ev.in)}` : "勤務を開始";
    if (a === "out") return ev.out !== undefined ? `記録済み ${clock(ev.out)}` : "勤務を終了";
    if (a === "bstart") {
      const b = ev.breaks[ev.breaks.length - 1];
      return b ? `直近 ${clock(b.start)}` : "休憩に入る";
    }
    const b = [...ev.breaks].reverse().find((x) => x.end !== undefined);
    return b ? `直近 ${clock(b.end!)}` : "休憩から戻る";
  };

  const today = meToday(punch, min);
  const month = monthOf(ME, CURRENT_YM).result;
  const outlook = outlookOf(ME, CURRENT_YM);
  const mtdOt = month.overtimeMin + today.dailyOvertimeMin;
  const risk = riskOf(ME);
  const leave = leaveOf(ME);

  const statusPill =
    phase === "before" ? <Pill>出勤前</Pill> : phase === "working" ? <Pill tone="live">勤務中</Pill> : phase === "break" ? <Pill tone="warn">休憩中</Pill> : <Pill tone="ai">退勤済</Pill>;

  const timeline: { t: number; label: string; kind: string }[] = [];
  if (ev.in !== undefined) timeline.push({ t: ev.in, label: "出勤", kind: "in" });
  ev.breaks.forEach((b) => {
    timeline.push({ t: b.start, label: "休憩開始", kind: "brk" });
    if (b.end !== undefined) timeline.push({ t: b.end, label: "休憩終了", kind: "brk" });
  });
  if (ev.out !== undefined) timeline.push({ t: ev.out, label: "退勤", kind: "out" });
  timeline.sort((a, b) => a.t - b.t);

  const elapsed = ev.in === undefined ? "" : `出勤から ${dur((ev.out ?? min) - ev.in)} 経過`;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>打刻</h1>
          <p>{ME.name}さん（{ME.dept}）</p>
        </div>
      </header>

      <div className="punch">
        <section className="panel" aria-label="打刻">
          <div className="clockface">
            <span className="status">{statusPill}</span>
            <div className="big num" aria-label={`現在時刻 ${hh}時${mm}分`}>
              {hh}:{mm}
              <span className="sec" aria-hidden="true">{ss}</span>
            </div>
            <div className="date">{jpDate(TODAY)}</div>
            <div className="elapsed">{elapsed}</div>
          </div>
          <div className="punch-actions">
            <button type="button" className="pbtn main-act" disabled={!enabled.in} onClick={() => stamp("in")}>
              <span className="ic"><LogIn size={20} /></span>
              <span><b>出勤</b><small>{last("in")}</small></span>
            </button>
            <button type="button" className="pbtn main-act" disabled={!enabled.out} onClick={() => stamp("out")}>
              <span className="ic"><LogOut size={20} /></span>
              <span><b>退勤</b><small>{last("out")}</small></span>
            </button>
            <button type="button" className="pbtn" disabled={!enabled.bstart} onClick={() => stamp("bstart")}>
              <span className="ic"><Coffee size={20} /></span>
              <span><b>休憩開始</b><small>{last("bstart")}</small></span>
            </button>
            <button type="button" className="pbtn" disabled={!enabled.bend} onClick={() => stamp("bend")}>
              <span className="ic"><Play size={20} /></span>
              <span><b>休憩終了</b><small>{last("bend")}</small></span>
            </button>
          </div>
          <div className="toast" role="status" aria-live="polite">{toast}</div>
        </section>

        <div className="stack">
          <section className="panel" aria-labelledby="rec">
            <div className="panel-head">
              <h2 id="rec">本日の記録</h2>
              {ev.in !== undefined ? (
                <button type="button" className="btn sm text" onClick={() => { actions.resetToday(); setToast(""); }}>
                  記録をリセット
                </button>
              ) : null}
            </div>
            {timeline.length === 0 ? (
              <div className="empty"><b>まだ打刻がありません</b>「出勤」を押すと記録が始まります。</div>
            ) : (
              <ol className="timeline">
                {timeline.map((t, i) => (
                  <li key={i} className={t.kind}>
                    <span className="num">{clock(t.t)}</span>
                    <span>{t.label}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="panel" aria-labelledby="sum">
            <div className="panel-head"><h2 id="sum">本日の集計</h2></div>
            <div className="panel-body">
              <dl className="kv">
                <div><dt>実働</dt><dd>{durOrDash(today.workMin)}</dd></div>
                <div><dt>法定内</dt><dd>{durOrDash(today.legalInMin)}</dd></div>
                <div><dt>時間外</dt><dd>{durOrDash(today.dailyOvertimeMin)}</dd></div>
                <div><dt>深夜（22:00〜5:00）</dt><dd>{durOrDash(today.nightMin)}</dd></div>
              </dl>
            </div>
          </section>

          <section className="panel" aria-labelledby="mon">
            <div className="panel-head">
              <h2 id="mon">今月の時間外</h2>
              <RiskPill level={risk.level} />
            </div>
            <div className="panel-body">
              <div className="gauge-cell">
                <Gauge mtd={mtdOt} proj={Math.max(outlook.projOvertime, mtdOt)} scaleHours={60} tickHours={45} level={risk.level} />
                <span className="num">{dur(mtdOt)}</span>
              </div>
              <div className="gauge-scale"><span>0</span><span>45時間</span><span>60時間</span></div>
              <p className="note">月末見込は {dur(outlook.projOvertime)} です。有給の残りは {leave.remaining} 日です。</p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
