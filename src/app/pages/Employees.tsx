import { useMemo, useState, type FormEvent } from "react";
import { Copy, Download, KeyRound, Pencil, Plus, Search, Upload, UserMinus, UserPlus } from "lucide-react";
import { api, useApi } from "../api";
import type { EmployeeAdmin, EmployeesResponse, ImportResponse } from "../../domain/api";
import { csvDownload, shortDate } from "../format";
import { useSession } from "../session";
import { ConfirmDialog } from "../ui/Confirm";
import { Empty, Pill, Who } from "../ui/kit";
import { Modal } from "../ui/Modal";

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 表示は月曜はじまり
const DAY_CHAR = "日月火水木金土";
const CSV_HEADER = ["社員ID", "氏名", "部署", "役職", "雇用区分", "権限", "メール", "入社日", "所定労働日", "所定労働時間", "始業時刻", "繰越有給"];

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (v: string): number => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
const daysLabel = (d: number[]) => (d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x)) ? "月〜金" : DAY_ORDER.filter((x) => d.includes(x)).map((x) => DAY_CHAR[x]).join(""));

interface Cred {
  id: string;
  name: string;
  tempPassword: string;
}

export function Employees() {
  const { refresh } = useSession();
  const { data, error, loading, reload } = useApi<EmployeesResponse>("/api/employees");
  const [filter, setFilter] = useState<"active" | "left" | "all">("active");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<EmployeeAdmin | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "deactivate" | "reactivate" | "reset"; emp: EmployeeAdmin } | null>(null);

  const rows = data?.rows ?? [];
  const depts = useMemo(() => [...new Set(rows.map((r) => r.dept))], [rows]);
  const shown = rows.filter(
    (r) => (filter === "all" || (filter === "active") === r.active) && (!q || `${r.id}${r.name}`.replace(/\s/g, "").includes(q.replace(/\s/g, ""))),
  );

  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;
  const done = () => {
    reload();
    refresh();
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>社員管理</h1>
          <p>在籍 {data.seatsUsed}名 / 契約 {data.seatLimit}名まで</p>
        </div>
        <div className="tools">
          <div className="seg" role="group" aria-label="表示">
            {([["active", "在職"], ["left", "退職"], ["all", "すべて"]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          <label className="search">
            <Search size={16} />
            <input className="field" placeholder="氏名・社員IDで検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="氏名・社員IDで検索" />
          </label>
          <button type="button" className="btn" onClick={() => setImporting(true)}><Upload size={16} />CSV取り込み</button>
          <button type="button" className="btn primary" onClick={() => setEdit("new")}><Plus size={16} />社員を追加</button>
        </div>
      </header>

      <section className={`panel ${loading ? "dim" : ""}`}>
        {shown.length === 0 ? (
          <Empty title={rows.length === 0 ? "社員が登録されていません" : "該当する社員がいません"}>
            {rows.length === 0 ? "「社員を追加」またはCSV取り込みで登録してください。" : "表示や検索の条件を変えてください。"}
          </Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>社員</th><th>部署・役職</th><th>区分</th><th>所定</th><th>入社日</th><th>状態</th><th className="r">操作</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className={r.active ? "" : "rest"}>
                    <td><Who name={r.name} sub={`ID ${r.id}`} /></td>
                    <td>{r.dept}{r.title ? <span style={{ color: "var(--ink-3)" }}>・{r.title}</span> : null}</td>
                    <td>{r.kind}{r.role === "admin" ? <span style={{ marginLeft: 6 }}><Pill tone="ai" plain>管理者</Pill></span> : null}</td>
                    <td>{daysLabel(r.workDays)} {hm(r.schedStart)}〜 <span style={{ color: "var(--ink-3)" }}>{r.baseMin / 60}h</span></td>
                    <td>{r.hired.replace(/-/g, "/")}</td>
                    <td>
                      {!r.active ? <Pill plain>{r.leftOn ? `${shortDate(r.leftOn)} 退職` : "退職"}</Pill> : r.mustChangePassword ? <Pill tone="warn">初回ログイン前</Pill> : <Pill tone="ok">在職</Pill>}
                    </td>
                    <td className="r">
                      <span className="row-actions">
                        <button type="button" className="btn sm text" onClick={() => setEdit(r)} aria-label={`${r.name}を編集`}><Pencil size={14} />編集</button>
                        {r.active ? (
                          <>
                            <button type="button" className="btn sm text" onClick={() => setConfirm({ kind: "reset", emp: r })} aria-label={`${r.name}のパスワードを再発行`}><KeyRound size={14} />再発行</button>
                            <button type="button" className="btn sm text" onClick={() => setConfirm({ kind: "deactivate", emp: r })} aria-label={`${r.name}を退職処理`}><UserMinus size={14} />退職</button>
                          </>
                        ) : (
                          <button type="button" className="btn sm text" onClick={() => setConfirm({ kind: "reactivate", emp: r })} aria-label={`${r.name}を復職`}><UserPlus size={14} />復職</button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="note">退職処理をしても、在籍していた月の勤怠・申請の記録は残ります。退職者は契約人数に数えません。</p>

      <EmployeeDialog
        open={edit !== null}
        emp={edit === "new" ? null : edit}
        depts={depts}
        onClose={() => setEdit(null)}
        onSaved={(c) => {
          setEdit(null);
          done();
          if (c) setCreds([c]);
        }}
      />
      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={(c) => { done(); setCreds(c); }} />
      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} />

      <ConfirmDialog
        open={confirm?.kind === "deactivate"}
        title="退職処理"
        confirmLabel="退職処理をする"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api(`/api/employees/${encodeURIComponent(confirm!.emp.id)}/deactivate`, { method: "POST" });
          done();
        }}
      >
        <b>{confirm?.emp.name}</b>さんを退職扱いにします。ログインできなくなり、未処理の申請は取り下げられます。過去の勤怠は残ります。
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "reactivate"}
        title="復職"
        confirmLabel="復職させる"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api(`/api/employees/${encodeURIComponent(confirm!.emp.id)}/reactivate`, { method: "POST" });
          done();
        }}
      >
        <b>{confirm?.emp.name}</b>さんを在職に戻します。パスワードは変わりません。ログインできない場合は「再発行」してください。
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "reset"}
        title="パスワードの再発行"
        confirmLabel="再発行する"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await api<Cred & { id: string }>(`/api/employees/${encodeURIComponent(confirm!.emp.id)}/reset-password`, { method: "POST" });
          setCreds([{ id: r.id, name: confirm!.emp.name, tempPassword: r.tempPassword }]);
          done();
        }}
      >
        <b>{confirm?.emp.name}</b>さんの一時パスワードを発行します。いまのパスワードは使えなくなり、ログイン中の端末もログアウトされます。
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------- 追加・編集

function EmployeeDialog({ open, emp, depts, onClose, onSaved }: { open: boolean; emp: EmployeeAdmin | null; depts: string[]; onClose: () => void; onSaved: (c?: Cred) => void }) {
  return (
    <Modal open={open} onClose={onClose} title={emp ? `${emp.name}さんの情報を編集` : "社員を追加"}>
      {open ? <EmployeeForm key={emp?.id ?? "new"} emp={emp} depts={depts} onClose={onClose} onSaved={onSaved} /> : null}
    </Modal>
  );
}

function EmployeeForm({ emp, depts, onClose, onSaved }: { emp: EmployeeAdmin | null; depts: string[]; onClose: () => void; onSaved: (c?: Cred) => void }) {
  const { me, refresh } = useSession();
  const [f, setF] = useState({
    id: emp?.id ?? "",
    name: emp?.name ?? "",
    dept: emp?.dept ?? "",
    title: emp?.title ?? "",
    kind: emp?.kind ?? ("正社員" as "正社員" | "パート"),
    role: emp?.role ?? ("employee" as "admin" | "employee"),
    email: emp?.email ?? "",
    workDays: emp?.workDays ?? [1, 2, 3, 4, 5],
    baseHours: emp ? emp.baseMin / 60 : 8,
    start: emp ? hm(emp.schedStart) : "09:00",
    hired: emp?.hired ?? me.today,
    carry: emp?.carry ?? 0,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const toggleDay = (d: number) => set("workDays", f.workDays.includes(d) ? f.workDays.filter((x) => x !== d) : [...f.workDays, d]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = {
      name: f.name,
      dept: f.dept,
      title: f.title,
      kind: f.kind,
      role: f.role,
      email: f.email,
      workDays: f.workDays,
      baseMin: Math.round(f.baseHours * 60),
      schedStart: toMin(f.start),
      hired: f.hired,
      carry: f.carry,
    };
    try {
      if (emp) {
        await api(`/api/employees/${encodeURIComponent(emp.id)}`, { method: "PATCH", body });
        if (emp.id === me.employee.id) refresh();
        onSaved();
      } else {
        const r = await api<{ id: string; tempPassword: string }>("/api/employees", { method: "POST", body: { id: f.id, ...body } });
        onSaved({ id: r.id, name: f.name, tempPassword: r.tempPassword });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="row2">
        <label>社員ID<input className="field" value={f.id} onChange={(e) => set("id", e.target.value)} disabled={!!emp} required maxLength={30} autoCapitalize="none" /></label>
        <label>氏名<input className="field" value={f.name} onChange={(e) => set("name", e.target.value)} required maxLength={40} /></label>
      </div>
      <div className="row2">
        <label>
          部署
          <input className="field" list="dept-list" value={f.dept} onChange={(e) => set("dept", e.target.value)} required maxLength={30} />
          <datalist id="dept-list">{depts.map((d) => <option key={d} value={d} />)}</datalist>
        </label>
        <label>役職（任意）<input className="field" value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={20} /></label>
      </div>
      <div className="row2">
        <label>
          雇用区分
          <select className="field" value={f.kind} onChange={(e) => { const k = e.target.value as "正社員" | "パート"; setF((s) => ({ ...s, kind: k, baseHours: !emp && (s.baseHours === 8 || s.baseHours === 6) ? (k === "パート" ? 6 : 8) : s.baseHours })); }}>
            <option>正社員</option>
            <option>パート</option>
          </select>
        </label>
        <label>
          権限
          <select className="field" value={f.role} onChange={(e) => set("role", e.target.value as "admin" | "employee")}>
            <option value="employee">一般</option>
            <option value="admin">管理者</option>
          </select>
        </label>
      </div>
      <label>メールアドレス（任意）<input className="field" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} maxLength={120} /></label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 700, color: "var(--ink-2)", padding: 0, marginBottom: 5 }}>所定労働日</legend>
        <div className="daypick">
          {DAY_ORDER.map((d) => (
            <button key={d} type="button" aria-pressed={f.workDays.includes(d)} onClick={() => toggleDay(d)}>{DAY_CHAR[d]}</button>
          ))}
        </div>
      </fieldset>
      <div className="row2">
        <label>所定労働時間（1日・時間）<input className="field" type="number" min={1} max={12} step={0.25} value={f.baseHours} onChange={(e) => set("baseHours", Number(e.target.value))} required /></label>
        <label>始業時刻<input className="field" type="time" value={f.start} onChange={(e) => set("start", e.target.value)} required /></label>
      </div>
      <div className="row2">
        <label>入社日<input className="field" type="date" value={f.hired} onChange={(e) => set("hired", e.target.value)} required /></label>
        <label>繰越有給（日）<input className="field" type="number" min={0} max={40} step={0.5} value={f.carry} onChange={(e) => set("carry", Number(e.target.value))} /></label>
      </div>
      <div className="form-error" role="alert">{error}</div>
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>キャンセル</button>
        <button type="submit" className="btn primary" disabled={busy || f.workDays.length === 0}>{busy ? "保存中…" : emp ? "保存する" : "追加する"}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 一時パスワードの表示

function CredentialsDialog({ creds, onClose }: { creds: Cred[] | null; onClose: () => void }) {
  const [copied, setCopied] = useState("");
  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied("");
    }
  };
  return (
    <Modal open={creds !== null} onClose={onClose} title="一時パスワードを本人に伝えてください" wide dismissible={false}>
      <div className="form">
        <p style={{ margin: 0 }}>この画面を閉じると、パスワードは二度と表示できません。本人は初回ログイン時に、自分のパスワードへ変更します。</p>
        <div className="tbl-wrap" style={{ border: "1px solid var(--line)", borderRadius: 4, maxHeight: 280 }}>
          <table className="tbl">
            <thead><tr><th>社員ID</th><th>氏名</th><th>一時パスワード</th><th /></tr></thead>
            <tbody>
              {creds?.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>{c.name}</td>
                  <td><code className="pw">{c.tempPassword}</code></td>
                  <td className="r"><button type="button" className="btn sm text" onClick={() => copy(c.tempPassword, c.id)}><Copy size={14} />{copied === c.id ? "コピーしました" : "コピー"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          {creds && creds.length > 1 ? (
            <button type="button" className="btn" onClick={() => csvDownload("一時パスワード.csv", [["社員ID", "氏名", "一時パスワード"], ...creds.map((c) => [c.id, c.name, c.tempPassword])])}><Download size={16} />CSVでダウンロード</button>
          ) : null}
          <button type="button" className="btn primary" onClick={onClose}>伝え終わったので閉じる</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- CSV 取り込み

/** Excel が出力する Shift_JIS の CSV も読めるようにする */
async function readCsv(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (c: Cred[]) => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [check, setCheck] = useState<ImportResponse | null>(null);
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
      const r = await api<ImportResponse>("/api/employees/import", { method: "POST", body: { csv: text, dryRun } });
      if (r.ok && !r.dryRun) {
        onImported(r.credentials);
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

  const template = () =>
    csvDownload("社員取り込みテンプレート.csv", [
      CSV_HEADER,
      ["e101", "山田 太郎", "営業部", "課長", "正社員", "管理者", "taro@example.com", "2026-04-01", "月火水木金", "8", "9:00", "0"],
      ["e102", "鈴木 花子", "営業部", "", "パート", "一般", "", "2026-05-01", "月水金", "5", "10:00", "0"],
    ]);

  return (
    <Modal open={open} onClose={close} title="CSVから社員を取り込む" wide>
      <div className="form">
        <p style={{ margin: 0 }}>テンプレートに社員を入力して取り込みます。必須は「社員ID・氏名・部署・入社日」で、ほかは空欄のままで構いません（正社員・一般・月〜金・8時間・9:00として登録します）。</p>
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn" onClick={template}><Download size={16} />テンプレートをダウンロード</button>
          <label className="btn" style={{ cursor: "pointer" }}>
            <Upload size={16} />CSVファイルを選ぶ
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {fileName ? <span style={{ alignSelf: "center", color: "var(--ink-3)" }}>{fileName}</span> : null}
        </div>
        {check && !check.ok ? (
          <div className="tbl-wrap" style={{ border: "1px solid var(--line)", borderRadius: 4, maxHeight: 240 }} role="alert">
            <table className="tbl">
              <thead><tr><th>行</th><th>内容</th></tr></thead>
              <tbody>{check.errors.map((e, i) => <tr key={i}><td className="n">{e.row}</td><td style={{ whiteSpace: "normal" }}>{e.message}</td></tr>)}</tbody>
            </table>
          </div>
        ) : null}
        {check?.ok ? <div role="status"><Pill tone="ok">{check.dryRun ? check.count : 0}名を登録できます</Pill>　内容に問題はありません。</div> : null}
        {check && !check.ok ? <p className="note" style={{ margin: 0 }}>エラーを直してから、もう一度ファイルを選んでください。エラーがある間は、1名も登録されません。</p> : null}
        <div className="form-error" role="alert">{error}</div>
        <div className="actions">
          <button type="button" className="btn" onClick={close}>キャンセル</button>
          <button type="button" className="btn primary" disabled={busy || !csv || !check?.ok} onClick={() => run(csv, false)}>{busy ? "処理中…" : "取り込む"}</button>
        </div>
      </div>
    </Modal>
  );
}
