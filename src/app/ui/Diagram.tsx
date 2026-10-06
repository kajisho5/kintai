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

const AX0 = 7 * 60;
const AX1 = 23 * 60;
const HOURS = Array.from({ length: AX1 / 60 - AX0 / 60 + 1 }, (_, i) => AX0 / 60 + i);

const pct = (m: number) => `${Math.max(0, Math.min(100, ((m - AX0) / (AX1 - AX0)) * 100))}%`;
const width = (a: number, b: number) =>
  `${Math.max(0, (Math.min(AX1, b) - Math.max(AX0, a)) / (AX1 - AX0)) * 100}%`;

function Track({ row, now }: { row: TodayRow; now: number }) {
  const showLine = row.start !== undefined && row.bars.length > 0;
  const lineEnd = row.bars.length ? row.bars[row.bars.length - 1]!.to : 0;
  return (
    <div className="dg-track">
      {HOURS.map((h) => (
        <span key={h} className={`hr ${h % 3 === 0 ? "major" : ""}`} style={{ left: pct(h * 60) }} />
      ))}
      <span className="night" style={{ left: pct(22 * 60), width: width(22 * 60, AX1) }} />
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
        <span style={{ position: "absolute", left: pct(9 * 60), top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "var(--beni)", fontWeight: 700 }}>
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
                {h}
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
                  <Track row={r} now={now} />
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
