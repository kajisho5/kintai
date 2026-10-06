import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api } from "../api";
import type { AuditResponse, AuditRow } from "../../domain/api";
import { Empty } from "../ui/kit";

const when = (ms: number) =>
  new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** 内容（JSON）を、読みやすい1行にする */
function detailText(d: unknown): string {
  if (!d || typeof d !== "object") return "";
  return Object.entries(d as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("　");
}

/** 操作記録（監査ログ）。管理者だけが見られる */
export function Audit() {
  const [f, setF] = useState({ action: "", actor: "", from: "", to: "" });
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actions, setActions] = useState<AuditResponse["actions"]>([]);
  const [next, setNext] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const qs = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
      return p.toString();
    },
    [f],
  );

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError("");
      try {
        const r = await api<AuditResponse>(`/api/audit?${qs(before ? { before: String(before) } : {})}`);
        setRows((cur) => (before ? [...cur, ...r.rows] : r.rows));
        setNext(r.nextBefore);
        setActions(r.actions);
      } catch (e) {
        setError(e instanceof Error ? e.message : "読み込めませんでした");
      } finally {
        setLoading(false);
      }
    },
    [qs],
  );

  // 絞り込みを変えたら、少し待ってから取り直す
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>操作記録</h1>
          <p>誰が、いつ、何を操作したかの記録（新しい順）。管理者だけが見られます</p>
        </div>
        <div className="tools">
          <a className="btn" href={`/api/audit/export?${qs()}`} download><Download size={16} />CSVで書き出す</a>
        </div>
      </header>

      <section className="panel" aria-label="絞り込み">
        <form className="form holiday-add" onSubmit={(e) => e.preventDefault()} style={{ alignItems: "end" }}>
          <label>
            操作
            <select className="field" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
              <option value="">すべて</option>
              {actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
            </select>
          </label>
          <label>操作者の社員ID<input className="field" value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value.trim() })} placeholder="例: e16" autoCapitalize="none" style={{ maxWidth: 160 }} /></label>
          <label>期間（開始）<input className="field" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label>期間（終了）<input className="field" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        </form>
      </section>

      <section className={`panel ${loading ? "dim" : ""}`} aria-busy={loading}>
        {error ? <div className="status-error" role="alert">{error}</div> : null}
        {rows.length === 0 && !loading && !error ? (
          <Empty title="該当する記録がありません">絞り込みの条件を変えてください。</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>日時</th><th>操作者</th><th>操作</th><th>内容</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="n" style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                    <td>{r.actorName ?? r.actor}{r.actorName ? <small style={{ color: "var(--ink-3)", marginLeft: 6 }}>{r.actor}</small> : null}</td>
                    <td>{r.label}</td>
                    <td style={{ whiteSpace: "normal", color: "var(--ink-2)", wordBreak: "break-all" }}>{detailText(r.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next ? (
          <div className="actions" style={{ justifyContent: "center", padding: 14 }}>
            <button type="button" className="btn" disabled={loading} onClick={() => void load(next)}>さらに読み込む</button>
          </div>
        ) : null}
      </section>
      <p className="note">パスワードや暗証番号そのものは、記録に残りません。記録は、画面からは削除・変更できません。</p>
    </>
  );
}
