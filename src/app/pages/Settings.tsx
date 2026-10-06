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
        <WorkRulesPanel s={data} onSaved={() => { reload(); refresh(); }} />
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

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (v: string): number => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** 労働時間制度に関する設定（法定休日・週の法定労働時間・フレックス・1年単位の変形） */
function WorkRulesPanel({ s, onSaved }: { s: SettingsResponse; onSaved: () => void }) {
  const [legalDow, setLegalDow] = useState(s.legalHolidayDow);
  const [week44, setWeek44] = useState(s.week44);
  const [flexMonths, setFlexMonths] = useState(s.flexMonths);
  const [flexStart, setFlexStart] = useState(s.flexStartMonth);
  const [yearlyStart, setYearlyStart] = useState(s.yearlyStartMonth);
  const [rounding, setRounding] = useState(s.rounding);
  const [closing, setClosing] = useState(s.closingDay);
  const [core, setCore] = useState(s.flexCoreStart !== undefined);
  const [coreStart, setCoreStart] = useState(hm(s.flexCoreStart ?? 600));
  const [coreEnd, setCoreEnd] = useState(hm(s.flexCoreEnd ?? 900));
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: { legalHolidayDow: legalDow, week44, flexMonths, flexStartMonth: flexStart, yearlyStartMonth: yearlyStart, rounding, closingDay: closing, flexCore: core ? { start: toMin(coreStart), end: toMin(coreEnd) } : null },
      });
      setMsg("保存しました");
      onSaved();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="w-title">
      <div className="panel-head"><h2 id="w-title">労働時間制度<span className="sub">変形労働時間制・フレックスタイム制・法定休日</span></h2></div>
      <form className="form settings-form" onSubmit={save}>
        <label>
          法定休日の曜日
          <select className="field" style={{ maxWidth: 160 }} value={legalDow} onChange={(e) => setLegalDow(Number(e.target.value))}>
            {WD.map((d, i) => <option key={d} value={i}>{d}曜日</option>)}
          </select>
          <small className="hint">就業規則で定めた法定休日です。この日の勤務は休日労働（割増35%以上）として集計します。「シフト」で、週ごとに法定休日の日を指定した週は、その日が法定休日になります（4週4休などの変形休日制）。</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={week44} onChange={(e) => setWeek44(e.target.checked)} />
          <span>
            <b>週の法定労働時間が44時間（特例措置対象事業場）</b>
            <small className="hint">常時10人未満の、商業・映画演劇業（映画製作を除く）・保健衛生業・接客娯楽業の事業場だけが対象です。該当しない場合はオフのままにしてください（週40時間）。</small>
          </span>
        </label>
        <div className="row2">
          <label>
            フレックスタイム制の清算期間
            <select className="field" value={flexMonths} onChange={(e) => setFlexMonths(Number(e.target.value))}>
              {[1, 2, 3].map((m) => <option key={m} value={m}>{m}か月</option>)}
            </select>
          </label>
          <label>
            清算期間の起点月
            <select className="field" value={flexStart} onChange={(e) => setFlexStart(Number(e.target.value))}>
              {MONTHS.map((m) => <option key={m} value={m}>{m}月</option>)}
            </select>
          </label>
        </div>
        <small className="hint" style={{ marginTop: -6 }}>清算期間が1か月を超える場合は、各月の労働が週平均50時間を超えた分も、その月の時間外になります。</small>
        <label className="check">
          <input type="checkbox" checked={core} onChange={(e) => setCore(e.target.checked)} />
          <span><b>コアタイムがある</b><small className="hint">コアタイムに出勤・退勤が間に合わなかった日は、勤怠の備考に「コアタイム外」と表示します。</small></span>
        </label>
        {core ? (
          <div className="row2">
            <label>コアタイム 開始<input className="field" type="time" value={coreStart} onChange={(e) => setCoreStart(e.target.value)} required /></label>
            <label>コアタイム 終了<input className="field" type="time" value={coreEnd} onChange={(e) => setCoreEnd(e.target.value)} required /></label>
          </div>
        ) : null}
        <label>
          勤怠の締め日
          <select className="field" style={{ maxWidth: 200 }} value={closing} onChange={(e) => setClosing(Number(e.target.value))}>
            <option value={0}>月末締め</option>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}日締め</option>)}
          </select>
          <small className="hint">月の集計の区切りです。たとえば20日締めなら、前月21日〜当月20日が「当月分」になります。月の時間外（36協定の月の判定）も、この区切りで数えます。変更は過去の月の集計にも反映されます。</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={rounding === "month30"} onChange={(e) => setRounding(e.target.checked ? "month30" : "none")} />
          <span>
            <b>時間外・休日・深夜の月合計を30分単位で丸める</b>
            <small className="hint">1か月の各合計の1時間未満の端数を、30分未満は切り捨て、30分以上は1時間に切り上げます（昭63.3.14基発150で認められた賃金計算上の処理）。月の集計・CSVにだけ適用し、36協定のチェックは実際の時間で行います。1日ごと・打刻ごとの丸めは法令上認められないため、できません。</small>
          </span>
        </label>
        <label>
          1年単位の変形期間の起点月
          <select className="field" style={{ maxWidth: 160 }} value={yearlyStart} onChange={(e) => setYearlyStart(Number(e.target.value))}>
            {MONTHS.map((m) => <option key={m} value={m}>{m}月</option>)}
          </select>
          <small className="hint">労使協定で定めた対象期間（1年）の起点です。その月の1日から12か月を1つの変形期間として、総枠（週40時間×日数÷7）を計算します。</small>
        </label>
        <div className="actions" style={{ justifyContent: "flex-start", alignItems: "center" }}>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "保存中…" : "保存する"}</button>
          <span role="status" style={{ color: msg === "保存しました" ? "var(--matsu)" : "var(--beni)", fontWeight: 700 }}>{msg}</span>
        </div>
        <p className="note" style={{ margin: 0 }}>これらの設定は、過去の月の集計にも反映されます。労使協定の内容と合わせてください。</p>
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
        <h2 id="h-title">休日カレンダー<span className="sub">法定休日は「労働時間制度」の設定、所定の休みはそれぞれの社員の設定で扱います</span></h2>
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
