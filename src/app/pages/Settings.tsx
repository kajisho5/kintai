import { useMemo, useState, type FormEvent } from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import { api, useApi } from "../api";
import type { HolidayRow, SettingsResponse } from "../../domain/api";
import { dowOf } from "../../domain/calendar";
import { HOLIDAYS_JP_LAST_YEAR } from "../../domain/holidays-jp";
import { WD, shortDate } from "../format";
import { useSession } from "../session";
import { Pill } from "../ui/kit";

export function Settings() {
  const { me, refresh } = useSession();
  const { data, error, reload } = useApi<SettingsResponse>("/api/settings");
  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>会社設定</h1>
          <p>{data.company.name}（企業ID: {data.company.code}）</p>
        </div>
      </header>
      <div className="stack">
        <GeneralPanel s={data} onSaved={() => { reload(); refresh(); }} />
        <HolidayPanel holidays={data.holidays} stale={data.holidaysStale} today={me.today} onChanged={reload} />
        <section className="panel" aria-labelledby="x-title">
          <div className="panel-head"><h2 id="x-title">データの書き出し</h2></div>
          <div className="panel-body" style={{ display: "grid", gap: 12 }}>
            <p style={{ margin: 0 }}>社員・打刻・申請・有給・休日・操作記録を、すべてまとめてJSONファイルで書き出します（パスワード情報は含まれません）。契約が終了した後でも、閲覧のみの状態で書き出せます。</p>
            <div><a className="btn" href="/api/export" download><Download size={16} />全データを書き出す（JSON）</a></div>
            <p className="note" style={{ margin: 0 }}>月ごとの勤怠は、「勤怠一覧」のCSV出力をご利用ください。</p>
          </div>
        </section>
      </div>
    </>
  );
}

function GeneralPanel({ s, onSaved }: { s: SettingsResponse; onSaved: () => void }) {
  const [name, setName] = useState(s.company.name);
  const [special, setSpecial] = useState(s.specialClause);
  const [fy, setFy] = useState(s.fyStartMonth);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      await api("/api/settings", { method: "PATCH", body: { name, specialClause: special, fyStartMonth: fy } });
      setMsg("保存しました");
      onSaved();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="g-title">
      <div className="panel-head"><h2 id="g-title">基本設定</h2></div>
      <form className="form settings-form" onSubmit={save}>
        <label>会社名<input className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></label>
        <label className="check">
          <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
          <span>
            <b>特別条項付きの36協定を締結している</b>
            <small className="hint">オンにすると、月45時間を超えても直ちに違反とせず、特別条項の適用回数（年6回まで）と年720時間で判定します。オフの場合は月45時間・年360時間を上限として判定します。</small>
          </span>
        </label>
        <label>
          36協定の起算月
          <select className="field" style={{ maxWidth: 160 }} value={fy} onChange={(e) => setFy(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}月</option>)}
          </select>
          <small className="hint">協定書に記載の起算日の月です。年の時間外累計はこの月から数えます。</small>
        </label>
        <div className="actions" style={{ justifyContent: "flex-start", alignItems: "center" }}>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "保存中…" : "保存する"}</button>
          <span role="status" style={{ color: msg === "保存しました" ? "var(--matsu)" : "var(--beni)", fontWeight: 700 }}>{msg}</span>
        </div>
      </form>
    </section>
  );
}

function HolidayPanel({ holidays, stale, today, onChanged }: { holidays: HolidayRow[]; stale: boolean; today: string; onChanged: () => void }) {
  const years = useMemo(() => [...new Set(holidays.map((h) => h.date.slice(0, 4)))], [holidays]);
  const [year, setYear] = useState(() => (years.includes(today.slice(0, 4)) ? today.slice(0, 4) : (years[years.length - 1] ?? today.slice(0, 4))));
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const shown = holidays.filter((h) => h.date.startsWith(year));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api("/api/settings/holidays", { method: "POST", body: { date, name } });
      setDate("");
      setName("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "追加に失敗しました");
    }
  };
  const remove = async (d: string) => {
    setError("");
    try {
      await api(`/api/settings/holidays/${d}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    }
  };

  return (
    <section className="panel" aria-labelledby="h-title">
      <div className="panel-head">
        <h2 id="h-title">休日カレンダー<span className="sub">日曜は法定休日、土曜と所定の休みはそれぞれの社員の設定で扱います</span></h2>
        <div className="seg" role="group" aria-label="年">
          {years.map((y) => <button key={y} type="button" aria-pressed={year === y} onClick={() => setYear(y)}>{y}</button>)}
        </div>
      </div>
      {stale ? (
        <div className="status-error" role="alert">祝日データが{HOLIDAYS_JP_LAST_YEAR}年までです。来年の祝日は内閣府の公表後に更新されます。それまでの間は、下の「会社の休日」として追加できます。</div>
      ) : null}
      <form className="form holiday-add" onSubmit={add}>
        <label>日付<input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        <label>名称<input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 創立記念日・年末年始休暇" required maxLength={30} /></label>
        <button type="submit" className="btn"><Plus size={16} />会社の休日を追加</button>
      </form>
      {error ? <div className="status-error" role="alert">{error}</div> : null}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>日付</th><th>名称</th><th>種別</th><th className="r">操作</th></tr></thead>
          <tbody>
            {shown.map((h) => {
              const w = dowOf(h.date);
              return (
                <tr key={h.date}>
                  <td className={w === 0 ? "sun" : w === 6 ? "sat" : ""}>{shortDate(h.date)}（{WD[w]}）</td>
                  <td>{h.name}</td>
                  <td>{h.kind === "company" ? <Pill tone="ai" plain>会社の休日</Pill> : <Pill plain>国民の祝日</Pill>}</td>
                  <td className="r"><button type="button" className="btn sm text" onClick={() => remove(h.date)} aria-label={`${h.name}を削除`}><Trash2 size={14} />削除</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ padding: "0 18px 14px" }}>国民の祝日を削除すると、その日は出勤日として扱われます（祝日に営業する会社向け）。変更は過去の月の集計にも反映されます。</p>
    </section>
  );
}
