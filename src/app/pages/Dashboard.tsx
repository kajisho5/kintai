import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { api, useApi } from "../api";
import type { DashboardResponse } from "../../domain/api";
import { hours1, jpDate, shortDate } from "../format";
import { useClock, useSession } from "../session";
import { Diagram } from "../ui/Diagram";
import { Empty, Figure, Gauge, RiskPill, Who } from "../ui/kit";

export function Dashboard({ go }: { go: (to: string) => void }) {
  const { refresh } = useSession();
  const clock = useClock();
  const { data, error, reload } = useApi<DashboardResponse>("/api/dashboard", { refreshMs: 30_000 });
  const [dept, setDept] = useState("all");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const depts = useMemo(() => [...new Set(data?.rows.map((r) => r.emp.dept) ?? [])], [data]);

  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;

  const count = (...s: string[]) => data.rows.filter((r) => s.includes(r.status)).length;
  const missing = count("missing");

  const decide = async (id: number, decision: "approved" | "rejected") => {
    setBusy(true);
    setActionError("");
    try {
      await api(`/api/requests/${id}/decision`, { method: "POST", body: { decision } });
      reload();
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>ダッシュボード</h1>
          <p>{jpDate(data.today)}の勤務状況と、36協定の見込</p>
        </div>
        <div className="now" aria-label="現在時刻">
          <span className="num">{clock.hh}:{clock.mm}:{clock.ss}</span>
          <small>{data.headcount}名在籍</small>
        </div>
      </header>

      <div className="stack">
        <section className="figures" aria-label="本日のサマリー">
          <Figure label="勤務中" value={count("working", "break")} unit="名" sub={`うち休憩中 ${count("break")}名`} />
          <Figure label="退勤済" value={count("left")} unit="名" sub="本日の勤務を終了" />
          <Figure label="出勤前" value={count("before", "missing")} unit="名" sub={missing ? `打刻なし ${missing}名` : "遅れている人はいません"} warn={missing > 0} hot={missing > 0} />
          <Figure label="休暇・休み" value={count("leave", "off")} unit="名" sub="有給・半休・公休" />
          <Figure label="承認待ち" value={data.pendingTotal} unit="件" sub="申請の確認が必要です" />
          <Figure label="36協定の注意" value={data.watchTotal} unit="名" sub={data.violating ? `違反の恐れ ${data.violating}名` : "月末見込ベース"} warn={data.violating > 0} hot={data.violating > 0} />
        </section>

        <section className="panel" aria-labelledby="dg-title">
          <div className="panel-head">
            <h2 id="dg-title">本日の勤務ダイヤ</h2>
            <div className="tools">
              <div className="legend" aria-label="凡例">
                <span><i /> 通常</span>
                <span><i className="ot" /> 時間外</span>
                <span><i className="plan" /> 予定</span>
                <span><i className="gap" /> 休憩</span>
              </div>
              <select className="field" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="部署で絞り込む">
                <option value="all">全部署</option>
                {depts.map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <Diagram rows={data.rows} now={clock.min} dept={dept} />
        </section>

        <div className="cols-2">
          <section className="panel" aria-labelledby="w-title">
            <div className="panel-head">
              <h2 id="w-title">36協定の月末見込<span className="sub">時間外労働（休日労働を除く）</span></h2>
              <span className="legend"><span>縦線は月45時間</span></span>
            </div>
            {data.watch.length === 0 ? (
              <Empty title="注意が必要な社員はいません">月末見込はすべて基準内です。</Empty>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>社員</th><th>累計と月末見込（0〜80時間）</th><th className="r">年累計</th><th>判定</th></tr>
                  </thead>
                  <tbody>
                    {data.watch.map(({ emp, risk }) => (
                      <tr key={emp.id} className="clickable" tabIndex={0} onClick={() => go(`attendance/${emp.id}`)} onKeyDown={(ev) => ev.key === "Enter" && go(`attendance/${emp.id}`)}>
                        <td><Who name={emp.name} sub={emp.dept} /></td>
                        <td style={{ minWidth: 260 }}>
                          <div className="gauge-cell">
                            <Gauge mtd={risk.outlook.mtdOvertime} proj={risk.outlook.projOvertime} scaleHours={80} tickHours={45} level={risk.level} />
                            <span className="num">{hours1(risk.outlook.projOvertime)}h</span>
                          </div>
                        </td>
                        <td className="r">{Math.round(risk.yearOvertime / 60)}h</td>
                        <td><RiskPill level={risk.level} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="note" style={{ padding: "0 18px 14px" }}>
              累計は前日までの実績、斜線は月末までの見込です。見込は当月の実績と直近3か月の平均から算出しています。
            </p>
          </section>

          <section className="panel" aria-labelledby="a-title">
            <div className="panel-head">
              <h2 id="a-title">承認待ち</h2>
              <a className="link" href="#/approvals">すべて見る</a>
            </div>
            {actionError ? <div className="status-error" role="alert">{actionError}</div> : null}
            {data.pending.length === 0 ? (
              <Empty title="承認待ちの申請はありません">新しい申請があるとここに表示されます。</Empty>
            ) : (
              <ul className="req-list">
                {data.pending.map((q) => (
                  <li key={q.id}>
                    <div>
                      <Who name={q.emp.name} sub={`${q.kind}・${shortDate(q.date)}`} />
                      <div className="d">{q.detail}</div>
                    </div>
                    <span className="row-actions">
                      <button className="btn sm ok" type="button" disabled={busy} onClick={() => decide(q.id, "approved")}><Check size={14} />承認</button>
                      <button className="btn sm" type="button" disabled={busy} onClick={() => decide(q.id, "rejected")}><X size={14} />却下</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
