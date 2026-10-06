import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Plus, Undo2, X } from "lucide-react";
import { api, useApi } from "../api";
import type { NewRequest, RequestView } from "../../domain/api";
import { jpDate, shortDate } from "../format";
import { useSession } from "../session";
import { Empty, Pill, Who } from "../ui/kit";

type Tab = "pending" | "approved" | "rejected";
const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "承認待ち" },
  { key: "approved", label: "承認済み" },
  { key: "rejected", label: "却下・取り下げ" },
];
const KIND_TONE: Record<RequestView["kind"], "ai" | "warn" | ""> = { 残業申請: "warn", 休日出勤: "warn", 打刻修正: "", 有給申請: "ai" };
const KINDS: RequestView["kind"][] = ["残業申請", "休日出勤", "有給申請", "打刻修正"];

const toMin = (hhmm: string): number | undefined => (/^\d{2}:\d{2}$/.test(hhmm) ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) : undefined);

export function Approvals() {
  const { me, isAdmin, refresh } = useSession();
  const { data, error, loading, reload } = useApi<RequestView[]>("/api/requests");
  const [tab, setTab] = useState<Tab>("pending");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const list = data ?? [];
  const tabOf = (r: RequestView): Tab => (r.status === "cancelled" ? "rejected" : r.status);
  const counts = { pending: 0, approved: 0, rejected: 0 };
  list.forEach((r) => counts[tabOf(r)]++);
  const shown = list.filter((r) => tabOf(r) === tab);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError("");
    try {
      await fn();
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
          <h1>申請・承認</h1>
          <p>{isAdmin ? "残業・休日出勤・有給・打刻修正の申請を確認します" : "自分の申請の状況を確認できます"}</p>
        </div>
        <div className="tools">
          <div className="seg" role="group" aria-label="状態">
            {TABS.map((t) => (
              <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label} {counts[t.key]}
              </button>
            ))}
          </div>
          <button type="button" className="btn primary" onClick={() => setOpen(true)}><Plus size={16} />新規申請</button>
        </div>
      </header>

      {actionError ? <div className="status-error" role="alert">{actionError}</div> : null}
      <section className={`panel ${loading ? "dim" : ""}`}>
        {!data ? (
          <p className={error ? "status-error" : "empty"} role="status">{error ?? "読み込んでいます…"}</p>
        ) : shown.length === 0 ? (
          <Empty title={tab === "pending" ? "承認待ちの申請はありません" : "該当する申請はありません"}>
            {tab === "pending" ? "新しい申請があるとここに表示されます。" : ""}
          </Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>申請者</th><th>種別</th><th>対象日</th><th>内容</th><th>理由</th><th>申請日</th><th className="r">{tab === "pending" ? "操作" : "結果"}</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const mine = r.emp.id === me.employee.id;
                  return (
                    <tr key={r.id}>
                      <td><Who name={r.emp.name} sub={r.emp.dept} /></td>
                      <td><Pill tone={KIND_TONE[r.kind]} plain>{r.kind}</Pill></td>
                      <td>{jpDate(r.date)}</td>
                      <td>{r.detail}</td>
                      <td style={{ color: "var(--ink-2)", whiteSpace: "normal", minWidth: 160 }}>{r.reason}</td>
                      <td>{shortDate(r.createdDate)}</td>
                      <td className="r">
                        <span className="row-actions">
                          {r.status === "pending" ? (
                            <>
                              {isAdmin && !mine ? (
                                <>
                                  <button type="button" className="btn sm ok" disabled={busy} onClick={() => act(() => api(`/api/requests/${r.id}/decision`, { method: "POST", body: { decision: "approved" } }))}><Check size={14} />承認</button>
                                  <button type="button" className="btn sm" disabled={busy} onClick={() => act(() => api(`/api/requests/${r.id}/decision`, { method: "POST", body: { decision: "rejected" } }))}><X size={14} />却下</button>
                                </>
                              ) : null}
                              {mine ? (
                                <button type="button" className="btn sm text" disabled={busy} onClick={() => act(() => api(`/api/requests/${r.id}`, { method: "DELETE" }))}><Undo2 size={14} />取り下げ</button>
                              ) : null}
                            </>
                          ) : (
                            <Pill tone={r.status === "approved" ? "ok" : "bad"}>{r.status === "approved" ? "承認" : r.status === "rejected" ? "却下" : "取り下げ"}</Pill>
                          )}
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
      {isAdmin ? <p className="note">自分の申請は承認・却下できません（他の管理者が処理します）。</p> : null}

      <RequestDialog open={open} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); setTab("pending"); reload(); refresh(); }} />
    </>
  );
}

function RequestDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { me } = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<RequestView["kind"]>("残業申請");
  const [date, setDate] = useState(me.today);
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("20:00");
  const [days, setDays] = useState<1 | 0.5>(1);
  const [inT, setInT] = useState("");
  const [outT, setOutT] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setError("");
      setDate(me.today);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open, me.today]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let body: NewRequest;
    if (kind === "有給申請") body = { kind, date, days, reason };
    else if (kind === "打刻修正") body = { kind, date, in: toMin(inT), out: toMin(outT), reason };
    else {
      const s = toMin(start);
      const en = toMin(end);
      if (s === undefined || en === undefined) return setError("開始と終了の時刻を入力してください");
      body = { kind, date, start: s, end: en, reason };
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/requests", { method: "POST", body });
      setReason("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "申請に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dlg" onClose={onClose} aria-labelledby="req-title">
      <header>
        <h2 id="req-title">新規申請</h2>
        <button type="button" className="btn sm text" onClick={onClose} aria-label="閉じる"><X size={16} /></button>
      </header>
      <form className="form" onSubmit={submit}>
        <label>
          種別
          <select className="field" value={kind} onChange={(e) => { setKind(e.target.value as RequestView["kind"]); setError(""); }}>
            {KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label>
          対象日
          <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        {kind === "残業申請" || kind === "休日出勤" ? (
          <div className="row2">
            <label>開始<input className="field" type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
            <label>終了<input className="field" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required /></label>
          </div>
        ) : null}
        {kind === "有給申請" ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 700, color: "var(--ink-2)", padding: 0, marginBottom: 5 }}>取得日数</legend>
            <div className="radio-row">
              <label><input type="radio" name="days" checked={days === 1} onChange={() => setDays(1)} />全日（1日）</label>
              <label><input type="radio" name="days" checked={days === 0.5} onChange={() => setDays(0.5)} />半休（0.5日）</label>
            </div>
          </fieldset>
        ) : null}
        {kind === "打刻修正" ? (
          <>
            <div className="row2">
              <label>正しい出勤時刻<input className="field" type="time" value={inT} onChange={(e) => setInT(e.target.value)} /></label>
              <label>正しい退勤時刻<input className="field" type="time" value={outT} onChange={(e) => setOutT(e.target.value)} /></label>
            </div>
            <p className="note" style={{ margin: 0 }}>直す方だけ入力してください。その日の打刻が無い場合は両方を入力します。</p>
          </>
        ) : null}
        <label>
          理由
          <textarea className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} required />
        </label>
        <div className="form-error" role="alert">{error}</div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>キャンセル</button>
          <button type="submit" className="btn primary" disabled={busy || !reason.trim()}>{busy ? "送信中…" : "申請する"}</button>
        </div>
      </form>
    </dialog>
  );
}
