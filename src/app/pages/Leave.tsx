import { useMemo } from "react";
import { useApi } from "../api";
import type { LeaveResponse } from "../../domain/api";
import type { LeaveInfo } from "../../domain/types";
import { jpDate } from "../format";
import { useSession } from "../session";
import { Empty, Figure, Pill, Who } from "../ui/kit";

const OBLIGATION_URGENT_DAYS = 120;
const fmtDate = (d?: string) => (d ? d.replace(/-/g, "/") : "–");
const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function needsAction(l: LeaveInfo): boolean {
  return l.obligationLeft > 0 && (l.daysToDeadline ?? 999) <= OBLIGATION_URGENT_DAYS;
}

export function Leave() {
  const { isAdmin } = useSession();
  const { data, error } = useApi<LeaveResponse>("/api/leave");
  const list = useMemo(
    () =>
      [...(data?.rows ?? [])].sort(
        (a, b) => Number(needsAction(b)) - Number(needsAction(a)) || b.obligationLeft - a.obligationLeft || (a.daysToDeadline ?? 999) - (b.daysToDeadline ?? 999),
      ),
    [data],
  );
  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;

  const urgent = list.filter(needsAction);
  const eligible = list.filter((l) => l.granted >= 10);
  const done = eligible.filter((l) => l.obligationLeft === 0).length;
  const remainingTotal = list.reduce((s, l) => s + l.remaining, 0);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>有給管理</h1>
          <p>{jpDate(data.today)}時点。年10日以上の付与がある社員は、付与から1年以内に5日の取得が必要です</p>
        </div>
      </header>

      <div className="stack">
        <section className="figures" aria-label="有給のサマリー">
          <Figure label="年5日の取得義務を達成" value={done} unit={`/ ${eligible.length}名`} sub="付与10日以上の社員" />
          <Figure label="期限が近い未達成" value={urgent.length} unit="名" sub={`期限まで${OBLIGATION_URGENT_DAYS}日以内`} warn={urgent.length > 0} hot={urgent.length > 0} />
          <Figure label={isAdmin ? "有給の残日数（全社）" : "有給の残日数"} value={fmtDays(remainingTotal)} unit="日" sub="繰越を含む" />
        </section>

        <section className="panel">
          {list.length === 0 ? (
            <Empty title="対象の社員がいません" />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>社員</th><th>入社日</th><th>直近の付与日</th><th className="r">付与</th><th>出勤率</th><th className="r">繰越</th>
                    <th className="r">取得</th><th className="r">残</th><th>年5日の取得</th><th>取得期限</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((l) => {
                    const act = needsAction(l);
                    const has = l.granted >= 10;
                    const got = Math.min(5, Math.floor(l.taken));
                    return (
                      <tr key={l.emp.id}>
                        <td><Who name={l.emp.name} sub={`${l.emp.dept}・週${l.emp.weeklyDays}日`} /></td>
                        <td>{fmtDate(l.emp.hired)}</td>
                        <td>{l.lastGrant ? fmtDate(l.lastGrant) : <span style={{ color: "var(--ink-3)" }}>付与前（{fmtDate(l.nextGrant)}）</span>}</td>
                        <td className="r">{fmtDays(l.granted)}</td>
                        <td>
                          {l.attendanceRate !== undefined ? (
                            <Pill tone={l.attendanceRate >= 0.8 ? "ok" : "bad"} plain>{(l.attendanceRate * 100).toFixed(1)}%{l.attendanceRate < 0.8 ? "（8割未満）" : ""}</Pill>
                          ) : l.lastGrant ? (
                            <span style={{ color: "var(--ink-3)", fontSize: 12 }} title="打刻の記録が無い期間を含むため、実績から判定できません。8割以上として付与しています。">仮定（8割以上）</span>
                          ) : "–"}
                        </td>
                        <td className="r">{fmtDays(l.carry)}</td>
                        <td className="r">
                          {fmtDays(l.taken)}
                          {l.planned ? <span style={{ color: "var(--ink-3)", fontSize: 12, marginLeft: 4 }}>+予定{fmtDays(l.planned)}</span> : null}
                        </td>
                        <td className="r"><b>{fmtDays(l.remaining)}</b></td>
                        <td>
                          {has ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                              <span className={`dots ${act ? "bad" : ""}`} aria-hidden="true">
                                {[0, 1, 2, 3, 4].map((i) => <i key={i} className={i < got ? "on" : ""} />)}
                              </span>
                              {l.obligationLeft === 0 ? <Pill tone="ok">達成</Pill> : act ? <Pill tone="bad">あと{fmtDays(l.obligationLeft)}日</Pill> : <Pill tone="warn">あと{fmtDays(l.obligationLeft)}日</Pill>}
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
        <p className="note">付与日数は労働基準法39条の付与表（通常・比例付与）に基づきます。出勤率は、付与日の直前の期間（初回は入社から6か月、以降は1年）の、所定労働日に対する出勤日（有給の日を含む）の割合で判定し、8割未満は付与しません。打刻の記録が無い期間を含む場合は、実績から判定できないため、8割以上として付与しています。業務上の傷病・産前産後・育児介護休業などで休んだ日は出勤として扱う必要がありますが、自動では扱わないため、該当する社員は確認してください。取得は承認済みの有給と登録済みの取得日の合計です。</p>
      </div>
    </>
  );
}
