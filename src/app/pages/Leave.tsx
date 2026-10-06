import { useMemo } from "react";
import { EMPLOYEES, TODAY, leaveOf, type LeaveInfo } from "../data";
import { jpDate } from "../format";
import { Empty, Figure, Pill, Who } from "../ui/kit";

const OBLIGATION_URGENT_DAYS = 120;

const fmtDate = (d?: string) => (d ? d.replace(/-/g, "/") : "–");

function needsAction(l: LeaveInfo): boolean {
  return l.obligationLeft > 0 && (l.daysToDeadline ?? 999) <= OBLIGATION_URGENT_DAYS;
}

export function Leave() {
  const list = useMemo(
    () =>
      EMPLOYEES.map(leaveOf).sort((a, b) => Number(needsAction(b)) - Number(needsAction(a)) || b.obligationLeft - a.obligationLeft || (a.daysToDeadline ?? 999) - (b.daysToDeadline ?? 999)),
    [],
  );
  const urgent = list.filter(needsAction);
  const eligible = list.filter((l) => l.granted >= 10);
  const done = eligible.filter((l) => l.obligationLeft === 0).length;
  const remainingTotal = list.reduce((s, l) => s + l.remaining, 0);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>有給管理</h1>
          <p>{jpDate(TODAY)}時点。年10日以上の付与がある社員は、付与から1年以内に5日の取得が必要です</p>
        </div>
      </header>

      <div className="stack">
        <section className="figures" aria-label="有給のサマリー">
          <Figure label="年5日の取得義務を達成" value={done} unit={`/ ${eligible.length}名`} sub="付与10日以上の社員" />
          <Figure label="期限が近い未達成" value={urgent.length} unit="名" sub={`期限まで${OBLIGATION_URGENT_DAYS}日以内`} warn={urgent.length > 0} hot={urgent.length > 0} />
          <Figure label="有給の残日数（全社）" value={remainingTotal} unit="日" sub="繰越を含む" />
        </section>

        <section className="panel">
          {list.length === 0 ? (
            <Empty title="社員がいません" />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>社員</th><th>入社日</th><th>直近の付与日</th><th className="r">付与</th><th className="r">繰越</th>
                    <th className="r">取得</th><th className="r">残</th><th>年5日の取得</th><th>取得期限</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((l) => {
                    const act = needsAction(l);
                    const has = l.granted >= 10;
                    const got = Math.min(5, l.taken);
                    return (
                      <tr key={l.emp.id}>
                        <td><Who name={l.emp.name} sub={`${l.emp.dept}・週${l.emp.weeklyDays}日`} /></td>
                        <td>{fmtDate(l.emp.hired)}</td>
                        <td>{l.lastGrant ? fmtDate(l.lastGrant) : <span style={{ color: "var(--ink-3)" }}>付与前</span>}</td>
                        <td className="r">{l.granted}</td>
                        <td className="r">{l.carry}</td>
                        <td className="r">{l.taken}</td>
                        <td className="r"><b>{l.remaining}</b></td>
                        <td>
                          {has ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                              <span className={`dots ${act ? "bad" : ""}`} aria-hidden="true">
                                {[0, 1, 2, 3, 4].map((i) => <i key={i} className={i < got ? "on" : ""} />)}
                              </span>
                              {l.obligationLeft === 0 ? <Pill tone="ok">達成</Pill> : act ? <Pill tone="bad">あと{l.obligationLeft}日</Pill> : <Pill tone="warn">あと{l.obligationLeft}日</Pill>}
                            </span>
                          ) : (
                            <span style={{ color: "var(--ink-3)" }}>対象外（付与10日未満）</span>
                          )}
                        </td>
                        <td className={act ? "hot" : ""}>{l.daysToDeadline !== undefined ? `${fmtDate(l.periodEnd)}（残り${l.daysToDeadline}日）` : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className="note">付与日数は労働基準法39条の付与表（通常・比例付与）に基づき、出勤率8割以上として計算しています。取得日数はサンプルデータです。</p>
      </div>
    </>
  );
}
