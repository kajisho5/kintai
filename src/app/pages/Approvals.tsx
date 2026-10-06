import { useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import { REQUESTS, empById, type RequestItem, type RequestKind } from "../data";
import { jpDate, shortDate } from "../format";
import { actions, useStore } from "../store";
import { Empty, Pill, Who } from "../ui/kit";

type Tab = "pending" | "approved" | "rejected";
const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "承認待ち" },
  { key: "approved", label: "承認済み" },
  { key: "rejected", label: "却下" },
];
const KIND_TONE: Record<RequestKind, "ai" | "warn" | "ok" | ""> = { 残業申請: "warn", 休日出勤: "warn", 打刻修正: "", 有給申請: "ai" };

export function Approvals() {
  const { decisions } = useStore();
  const [tab, setTab] = useState<Tab>("pending");
  const stateOf = (r: RequestItem): Tab => decisions[r.id] ?? r.initial;
  const counts = { pending: 0, approved: 0, rejected: 0 };
  REQUESTS.forEach((r) => counts[stateOf(r)]++);
  const list = REQUESTS.filter((r) => stateOf(r) === tab);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>申請・承認</h1>
          <p>残業・休日出勤・有給・打刻修正の申請を確認します</p>
        </div>
        <div className="seg" role="group" aria-label="状態">
          {TABS.map((t) => (
            <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label} {counts[t.key]}
            </button>
          ))}
        </div>
      </header>

      <section className="panel">
        {list.length === 0 ? (
          <Empty title={tab === "pending" ? "承認待ちの申請はありません" : "該当する申請はありません"}>
            {tab === "pending" ? "新しい申請があるとここに表示されます。" : ""}
          </Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>申請者</th><th>種別</th><th>対象日</th><th>内容</th><th>理由</th><th>申請日</th><th className="r">操作</th></tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const e = empById(r.empId);
                  const decided = decisions[r.id];
                  return (
                    <tr key={r.id}>
                      <td><Who name={e.name} sub={e.dept} /></td>
                      <td><Pill tone={KIND_TONE[r.kind]} plain>{r.kind}</Pill></td>
                      <td>{jpDate(r.date)}</td>
                      <td>{r.detail}</td>
                      <td style={{ color: "var(--ink-2)" }}>{r.reason}</td>
                      <td>{shortDate(r.submitted)}</td>
                      <td className="r">
                        <span className="row-actions">
                          {tab === "pending" ? (
                            <>
                              <button type="button" className="btn sm ok" onClick={() => actions.decide(r.id, "approved")}><Check size={14} />承認</button>
                              <button type="button" className="btn sm" onClick={() => actions.decide(r.id, "rejected")}><X size={14} />却下</button>
                            </>
                          ) : decided ? (
                            <button type="button" className="btn sm text" onClick={() => actions.decide(r.id, undefined)}><Undo2 size={14} />元に戻す</button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
