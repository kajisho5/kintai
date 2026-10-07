import { useMemo, useState, type FormEvent } from "react";
import { Download, Layers, Upload } from "lucide-react";
import { api, useApi } from "../api";
import type { ImportRowError, ScheduleImportResponse, ScheduleItem, ScheduleResponse, ScheduleView } from "../../domain/api";
import { addYm, datesBetween, dowOf, lastDateOfMonth } from "../../domain/calendar";
import { WORK_STYLE_LABEL, type WorkStyle } from "../../domain/types";
import { WD, csvDownload, ymLabel } from "../format";
import { useSession } from "../session";
import { Empty, MonthPicker, Pill } from "../ui/kit";
import { Modal } from "../ui/Modal";

type Kind = "work" | "off" | "legal_off" | "clear";
const STYLE_SHORT: Record<WorkStyle, string> = { fixed: "", monthly: "1か月変形", yearly: "1年変形", weekly: "1週間変形", flex: "フレックス" };

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (v: string): number => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
const hourLabel = (m: number) => (m % 60 === 0 ? String(Math.floor(m / 60) % 24) : `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, "0")}`);
/** 勤務のセル表示: 9-18。翌日にまたがる終了は 22-7⁺ */
const shortRange = (s: number, e: number) => `${hourLabel(s)}-${hourLabel(e)}${e >= 1440 ? "⁺" : ""}`;

export function Schedule() {
  const { me, isAdmin } = useSession();
  const [ym, setYm] = useState(me.today.slice(0, 7));
  const { data, error, loading, reload } = useApi<ScheduleResponse>(`/api/schedules?ym=${ym}`);
  const [cell, setCell] = useState<{ empId: string; name: string; date: string } | null>(null);
  const [bulk, setBulk] = useState(false);
  const [importing, setImporting] = useState(false);

  const months = useMemo(() => Array.from({ length: 29 }, (_, i) => addYm(me.today.slice(0, 7), i - 14)), [me.today]);
  const byKey = useMemo(() => new Map((data?.rows ?? []).map((r) => [`${r.empId}|${r.date}`, r])), [data]);
  const dates = useMemo(() => datesBetween(`${ym}-01`, lastDateOfMonth(ym)), [ym]);

  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;
  const today = data.today;

  const text = (emp: ScheduleResponse["employees"][number], date: string): { label: string; cls: string; title: string } => {
    const row = byKey.get(`${emp.id}|${date}`);
    if (row) {
      if (row.kind === "work") return { label: shortRange(row.start!, row.end!), cls: "work", title: `${hm(row.start!)}〜${hm(row.end!)}（休憩${row.breakMin}分）` };
      if (row.kind === "legal_off") return { label: "法休", cls: "legal", title: "法定休日（週1回の休日として指定）" };
      return { label: "休", cls: "off", title: "休み" };
    }
    // シフトの登録が無い日は、社員の通常の週の予定になる
    const w = dowOf(date);
    const working = emp.workDays.includes(w) && !data.holidays[date];
    return working ? { label: "·", cls: "default", title: `通常の予定（${hm(emp.schedStart)}〜、${emp.baseMin / 60}時間）` } : { label: "", cls: "default-off", title: data.holidays[date] ?? "所定休日" };
  };

  const template = () =>
    csvDownload("シフト取り込みテンプレート.csv", [
      ["社員ID", "日付", "区分", "開始", "終了", "休憩（分）"],
      [data.employees[0]?.id ?? "e101", `${ym}-01`, "勤務", "9:00", "18:00", "60"],
      [data.employees[0]?.id ?? "e101", `${ym}-02`, "勤務", "22:00", "31:00", "60"],
      [data.employees[0]?.id ?? "e101", `${ym}-03`, "休み", "", "", ""],
      [data.employees[0]?.id ?? "e101", `${ym}-04`, "法定休日", "", "", ""],
    ]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>シフト</h1>
          <p>{isAdmin ? "勤務の予定を登録します。変形労働時間制では、これが「あらかじめ定めた労働時間」になります" : "あなたの勤務の予定です"}</p>
        </div>
        <div className="tools">
          <MonthPicker months={months} value={ym} onChange={setYm} />
          {isAdmin ? (
            <>
              <button type="button" className="btn" onClick={() => setImporting(true)}><Upload size={16} />CSV取り込み</button>
              <button type="button" className="btn primary" onClick={() => setBulk(true)}><Layers size={16} />まとめて入力</button>
            </>
          ) : null}
        </div>
      </header>

      <section className={`panel ${loading ? "dim" : ""}`} aria-label={`${ymLabel(ym)}のシフト`}>
        {data.employees.length === 0 ? (
          <Empty title="社員がいません">社員を登録すると、ここにシフトが表示されます。</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="sched" aria-label="シフト表">
              <thead>
                <tr>
                  <th className="who">社員</th>
                  {dates.map((d) => {
                    const w = dowOf(d);
                    return (
                      <th key={d} className={`${w === 0 ? "sun" : w === 6 ? "sat" : ""} ${data.holidays[d] ? "hol" : ""} ${d === today ? "today" : ""}`} title={data.holidays[d]}>
                        <span>{Number(d.slice(8))}</span>
                        <small>{WD[w]}</small>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.employees.map((emp) => (
                  <tr key={emp.id}>
                    <th className="who" scope="row">
                      <b>{emp.name}</b>
                      <small>{emp.workStyle !== "fixed" ? <Pill tone="live" plain>{STYLE_SHORT[emp.workStyle]}</Pill> : emp.dept}</small>
                    </th>
                    {dates.map((d) => {
                      const t = text(emp, d);
                      const w = dowOf(d);
                      const cls = `${t.cls} ${w === 0 ? "sun" : w === 6 ? "sat" : ""} ${data.holidays[d] ? "hol" : ""} ${d === today ? "today" : ""}`;
                      return (
                        <td key={d} className={cls} title={t.title}>
                          {isAdmin ? (
                            <button type="button" onClick={() => setCell({ empId: emp.id, name: emp.name, date: d })} aria-label={`${emp.name} ${d} ${t.title}`}>{t.label}</button>
                          ) : (
                            <span>{t.label}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="note">
        <b>9-18</b> は勤務（開始-終了、<b>22-7⁺</b> は翌日の7時までの夜勤）、<b>休</b> は休み、<b>法休</b> は週1回の法定休日として指定した日、<b>·</b> は登録がなく通常の週の予定どおりの日です。
        {isAdmin ? "セルを押して1日ずつ、または「まとめて入力」で期間・曜日を指定して登録できます。" : ""}
      </p>

      {isAdmin ? (
        <>
          <CellDialog
            target={cell}
            row={cell ? byKey.get(`${cell.empId}|${cell.date}`) : undefined}
            onClose={() => setCell(null)}
            onSaved={() => {
              setCell(null);
              reload();
            }}
          />
          <BulkDialog open={bulk} data={data} onClose={() => setBulk(false)} onSaved={() => { setBulk(false); reload(); }} />
          <ImportDialog open={importing} template={template} onClose={() => setImporting(false)} onImported={() => { setImporting(false); reload(); }} />
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- 入力フォーム（1日・まとめて共通）

interface Draft {
  kind: Kind;
  start: string;
  end: string;
  endNext: boolean;
  breakMin: number;
}

const initial = (row?: ScheduleView): Draft =>
  row?.kind === "work"
    ? { kind: "work", start: hm(row.start! % 1440), end: hm(row.end! % 1440), endNext: row.end! >= 1440, breakMin: row.breakMin }
    : { kind: row?.kind ?? "work", start: "09:00", end: "18:00", endNext: false, breakMin: 60 };

function toItem(empId: string, date: string, d: Draft): ScheduleItem {
  if (d.kind !== "work") return { empId, date, kind: d.kind };
  return { empId, date, kind: "work", start: toMin(d.start), end: toMin(d.end) + (d.endNext ? 1440 : 0), breakMin: d.breakMin };
}

function DraftFields({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 700, color: "var(--ink-2)", padding: 0, marginBottom: 5 }}>区分</legend>
        <div className="radio-row">
          {([["work", "勤務"], ["off", "休み"], ["legal_off", "法定休日"], ["clear", "登録をやめる"]] as const).map(([k, label]) => (
            <label key={k}><input type="radio" name="kind" checked={d.kind === k} onChange={() => set({ kind: k })} />{label}</label>
          ))}
        </div>
        {d.kind === "legal_off" ? <small className="hint">その日を含む週（日曜〜土曜）は、この日だけが法定休日になります（ほかの日の勤務は休日労働になりません）。</small> : null}
        {d.kind === "clear" ? <small className="hint">登録を消して、通常の週の予定（社員の所定労働日・時間）に戻します。</small> : null}
      </fieldset>
      {d.kind === "work" ? (
        <>
          <div className="row2">
            <label>開始<input className="field" type="time" value={d.start} onChange={(e) => set({ start: e.target.value })} required /></label>
            <label>終了<input className="field" type="time" value={d.end} onChange={(e) => set({ end: e.target.value })} required /></label>
          </div>
          <label className="check"><input type="checkbox" checked={d.endNext} onChange={(e) => set({ endNext: e.target.checked })} /><span>終了は翌日（夜勤など、日をまたぐ）</span></label>
          <label>休憩（分）<input className="field" type="number" min={0} max={600} step={5} value={d.breakMin} onChange={(e) => set({ breakMin: Number(e.target.value) })} style={{ maxWidth: 140 }} /></label>
        </>
      ) : null}
    </>
  );
}

async function save(items: ScheduleItem[]): Promise<void> {
  await api("/api/schedules", { method: "POST", body: { items } });
}

function CellDialog({ target, row, onClose, onSaved }: { target: { empId: string; name: string; date: string } | null; row?: ScheduleView; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal open={target !== null} onClose={onClose} title={target ? `${target.name}さん ${target.date.replace(/-/g, "/")}（${WD[dowOf(target.date)]}）` : ""}>
      {target ? <CellForm key={`${target.empId}|${target.date}`} target={target} row={row} onClose={onClose} onSaved={onSaved} /> : null}
    </Modal>
  );
}

function CellForm({ target, row, onClose, onSaved }: { target: { empId: string; date: string }; row?: ScheduleView; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(initial(row));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save([toItem(target.empId, target.date, d)]);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <DraftFields d={d} set={(p) => setD((s) => ({ ...s, ...p }))} />
      <div className="form-error" role="alert">{error}</div>
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>キャンセル</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "保存中…" : "保存する"}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- まとめて入力

function BulkDialog({ open, data, onClose, onSaved }: { open: boolean; data: ScheduleResponse; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="シフトをまとめて入力" wide>
      {open ? <BulkForm data={data} onClose={onClose} onSaved={onSaved} /> : null}
    </Modal>
  );
}

function BulkForm({ data, onClose, onSaved }: { data: ScheduleResponse; onClose: () => void; onSaved: () => void }) {
  const [ids, setIds] = useState<string[]>(() => data.employees.filter((e) => e.workStyle !== "fixed").map((e) => e.id));
  const [from, setFrom] = useState(`${data.ym}-01`);
  const [to, setTo] = useState(lastDateOfMonth(data.ym));
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [skipHol, setSkipHol] = useState(true);
  const [d, setD] = useState<Draft>(initial());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const targets = from && to && from <= to && to <= `${from.slice(0, 4)}-12-31` ? datesBetween(from, to).filter((x) => days.includes(dowOf(x)) && !(skipHol && data.holidays[x] && d.kind === "work")) : [];
  const count = targets.length * ids.length;
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (count === 0) return setError("対象の社員・日付がありません");
    if (count > 1000) return setError("一度に入力できるのは1000件までです。期間か社員を分けてください");
    setBusy(true);
    try {
      await save(ids.flatMap((id) => targets.map((date) => toItem(id, date, d))));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 700, color: "var(--ink-2)", padding: 0, marginBottom: 5 }}>対象の社員（{ids.length}名）</legend>
        <div className="actions" style={{ justifyContent: "flex-start", marginBottom: 6 }}>
          <button type="button" className="btn sm" onClick={() => setIds(data.employees.map((e) => e.id))}>全員</button>
          <button type="button" className="btn sm" onClick={() => setIds(data.employees.filter((e) => e.workStyle !== "fixed").map((e) => e.id))}>変形・フレックスの社員</button>
          <button type="button" className="btn sm" onClick={() => setIds([])}>選択を外す</button>
        </div>
        <div className="pick-list">
          {data.employees.map((e) => (
            <label key={e.id} className="check">
              <input type="checkbox" checked={ids.includes(e.id)} onChange={() => setIds((l) => toggle(l, e.id))} />
              <span>{e.name}{e.workStyle !== "fixed" ? <small style={{ marginLeft: 6, color: "var(--ink-3)" }}>{WORK_STYLE_LABEL[e.workStyle]}</small> : null}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row2">
        <label>期間（開始）<input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
        <label>期間（終了）<input className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 700, color: "var(--ink-2)", padding: 0, marginBottom: 5 }}>曜日</legend>
        <div className="daypick">
          {[1, 2, 3, 4, 5, 6, 0].map((w) => (
            <button key={w} type="button" aria-pressed={days.includes(w)} onClick={() => setDays((l) => toggle(l, w))}>{WD[w]}</button>
          ))}
        </div>
      </fieldset>
      <DraftFields d={d} set={(p) => setD((s) => ({ ...s, ...p }))} />
      {d.kind === "work" ? (
        <label className="check"><input type="checkbox" checked={skipHol} onChange={(e) => setSkipHol(e.target.checked)} /><span>祝日・会社の休日（この月に登録されているもの）には入力しない</span></label>
      ) : null}
      <p className="note" style={{ margin: 0 }}>{ids.length}名 × {targets.length}日 = <b>{count}件</b>を登録します。すでに登録のある日は上書きされます。</p>
      <div className="form-error" role="alert">{error}</div>
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>キャンセル</button>
        <button type="submit" className="btn primary" disabled={busy || count === 0}>{busy ? "保存中…" : "登録する"}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- CSV 取り込み

async function readCsv(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

function ImportDialog({ open, template, onClose, onImported }: { open: boolean; template: () => void; onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [check, setCheck] = useState<ScheduleImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setCsv("");
    setFileName("");
    setCheck(null);
    setError("");
    onClose();
  };
  const run = async (text: string, dryRun: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await api<ScheduleImportResponse>("/api/schedules/import", { method: "POST", body: { csv: text, dryRun } });
      if (r.ok && !r.dryRun) {
        onImported();
        close();
      } else setCheck(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取り込みに失敗しました");
    } finally {
      setBusy(false);
    }
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const text = await readCsv(file);
    setCsv(text);
    await run(text, true);
  };
  const errors: ImportRowError[] = check && !check.ok ? check.errors : [];

  return (
    <Modal open={open} onClose={close} title="CSVからシフトを取り込む" wide>
      <div className="form">
        <p style={{ margin: 0 }}>1行が1人・1日分です。区分は「勤務・休み・法定休日・削除」。勤務の終了が翌日にかかるときは 26:00 のように24時以降で書きます。すでに登録のある日は上書きされます。</p>
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn" onClick={template}><Download size={16} />テンプレートをダウンロード</button>
          <label className="btn" style={{ cursor: "pointer" }}>
            <Upload size={16} />CSVファイルを選ぶ
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {fileName ? <span style={{ alignSelf: "center", color: "var(--ink-3)" }}>{fileName}</span> : null}
        </div>
        {errors.length ? (
          <div className="tbl-wrap" style={{ border: "1px solid var(--line)", borderRadius: 4, maxHeight: 240 }} role="alert">
            <table className="tbl">
              <thead><tr><th>行</th><th>内容</th></tr></thead>
              <tbody>{errors.map((e, i) => <tr key={i}><td className="n">{e.row}</td><td style={{ whiteSpace: "normal" }}>{e.message}</td></tr>)}</tbody>
            </table>
          </div>
        ) : null}
        {check?.ok ? <div role="status"><Pill tone="ok">{check.count}件を登録できます</Pill>　内容に問題はありません。</div> : null}
        {errors.length ? <p className="note" style={{ margin: 0 }}>エラーを直してから、もう一度ファイルを選んでください。エラーがある間は、1件も登録されません。</p> : null}
        <div className="form-error" role="alert">{error}</div>
        <div className="actions">
          <button type="button" className="btn" onClick={close}>キャンセル</button>
          <button type="button" className="btn primary" disabled={busy || !csv || !check?.ok} onClick={() => run(csv, false)}>{busy ? "処理中…" : "取り込む"}</button>
        </div>
      </div>
    </Modal>
  );
}
