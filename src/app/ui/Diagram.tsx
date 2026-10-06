import { useMemo } from "react";
import type { Status, TodayRow } from "../../domain/types";
import { clock } from "../format";

const STATUS_LABEL: Record<Status, string> = {
  working: "勤務中",
  break: "休憩中",
  left: "退勤済",
  before: "出勤前",
  missing: "打刻なし",
  leave: "休暇",
  off: "休み",
};

interface Axis {
  ax0: number;
  ax1: number;
  hours: number[];
  pct: (m: number) => string;
  width: (a: number, b: number) => string;
}

const hourLabel = (h: number) => ((h % 24) + 24) % 24;

const MIN_AX0 = 7 * 60;
const MAX_AX1 = 23 * 60;

/** 横軸は既定で 7〜23 時。夜勤などで帯が範囲外に出る社員がいれば、その分だけ広げる（日またぎは前日の分がマイナスの時刻になる） */
function axisFor(rows: TodayRow[]): Axis {
  let lo = MIN_AX0;
  let hi = MAX_AX1;
  for (const r of rows) {
    for (const b of r.bars) {
      lo = Math.min(lo, b.from);
      hi = Math.max(hi, b.to);
    }
  }
  const ax0 = Math.max(-12 * 60, Math.floor(lo / 60) * 60);
  const ax1 = Math.min(36 * 60, Math.ceil(hi / 60) * 60);
  const span = ax1 - ax0;
  return {
    ax0,
    ax1,
    // 範囲が広いときは、目盛りを2時間おきにする
    hours: Array.from({ length: (ax1 - ax0) / 60 + 1 }, (_, i) => ax0 / 60 + i).filter((h) => span <= 20 * 60 || hourLabel(h) % 2 === 0),
    pct: (m) => `${Math.max(0, Math.min(100, ((m - ax0) / span) * 100))}%`,
    width: (a, b) => `${(Math.max(0, Math.min(ax1, b) - Math.max(ax0, a)) / span) * 100}%`,
  };
}

function Track({ row, now, axis }: { row: TodayRow; now: number; axis: Axis }) {
  const { ax0, ax1, hours: HOURS, pct, width } = axis;
  const AX0 = ax0;
  const showLine = row.start !== undefined && row.bars.length > 0;
  const lineEnd = row.bars.length ? row.bars[row.bars.length - 1]!.to : 0;
  return (
    <div className="dg-track">
      {HOURS.map((h) => (
        <span key={h} className={`hr ${h % 3 === 0 ? "major" : ""}`} style={{ left: pct(h * 60) }} />
      ))}
      {[-1, 0, 1].map((k) => (
        <span key={k} className="night" style={{ left: pct((22 + 24 * k) * 60), width: width((22 + 24 * k) * 60, (29 + 24 * k) * 60) }} />
      ))}
      {showLine ? <span className="line" style={{ left: pct(row.start!), width: width(row.start!, lineEnd) }} /> : null}
      {row.bars.map((b, i) => (
        <span
          key={i}
          className={`bar ${b.ot ? "ot" : ""} ${b.plan ? "plan" : ""}`}
          style={{ left: pct(b.from), width: width(b.from, b.to) }}
          title={`${clock(b.from)}–${clock(b.to)}${b.ot ? "（時間外）" : ""}${b.plan ? "（予定）" : ""}`}
        />
      ))}
      {row.status === "leave" && row.note ? (
        <span style={{ position: "absolute", left: pct(AX0 + 60), top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "var(--ink-3)" }}>{row.note}</span>
      ) : null}
      {row.status === "missing" ? (
        <span style={{ position: "absolute", left: pct(Math.max(AX0, 9 * 60)), top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "var(--beni)", fontWeight: 700 }}>
          始業時刻を過ぎています（{clock(Math.floor(now))} 時点で打刻なし）
        </span>
      ) : null}
    </div>
  );
}

export function Diagram({ rows, now, dept }: { rows: TodayRow[]; now: number; dept: string }) {
  const groups = useMemo(() => {
    const depts = [...new Set(rows.map((r) => r.emp.dept))];
    return depts.filter((d) => dept === "all" || d === dept).map((d) => ({ dept: d, rows: rows.filter((r) => r.emp.dept === d) }));
  }, [rows, dept]);
  const axis = useMemo(() => axisFor(rows), [rows]);
  const { ax0: AX0, ax1: AX1, hours: HOURS, pct } = axis;
  const nowVisible = now >= AX0 && now <= AX1;

  return (
    <div className="diagram">
      <div className="dg" role="table" aria-label="本日の勤務ダイヤ">
        <div className="dg-row head" role="row">
          <div className="dg-label" role="columnheader">
            <small>社員</small>
          </div>
          <div className="dg-ticks" aria-hidden="true">
            {HOURS.map((h) => (
              <span key={h} className={h === AX1 / 60 ? "last" : h === AX0 / 60 ? "first" : ""} style={{ left: pct(h * 60) }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          <div className="dg-status" role="columnheader">
            <small style={{ color: "var(--ink-3)" }}>状況</small>
          </div>
        </div>
        {groups.map((g) => {
          const active = g.rows.filter((r) => r.status === "working" || r.status === "break").length;
          return (
            <div key={g.dept} role="rowgroup">
              <div className="dg-row group">
                <div className="dg-label" style={{ gridColumn: "1 / -1" }}>
                  {g.dept}
                  <small>
                    勤務中 {active}名 / 全{g.rows.length}名
                  </small>
                </div>
              </div>
              {g.rows.map((r) => (
                <div key={r.emp.id} className="dg-row" role="row">
                  <div className="dg-label" role="cell">
                    <b>{r.emp.name}</b>
                    <small>{r.emp.title || r.emp.kind}</small>
                  </div>
                  <Track row={r} now={now} axis={axis} />
                  <div className={`dg-status ${r.status}`} role="cell">
                    <i />
                    {STATUS_LABEL[r.status]}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        {nowVisible ? (
          <div className="dg-layer" aria-hidden="true">
            <div className="nowline" style={{ left: pct(now) }} />
            <div className="nowflag" style={{ left: pct(now) }}>
              {clock(Math.floor(now))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
