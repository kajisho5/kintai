import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, Download, Search } from "lucide-react";
import { useApi } from "../api";
import type { AttendanceDetailResponse, AttendanceListResponse, AttendanceRow } from "../../domain/api";
import { datesBetween, dowOf } from "../../domain/calendar";
import { WORK_STYLE_LABEL, type DayPlan } from "../../domain/types";
import { WD, clock, csvDownload, dur, durOrDash, hours1, shortDate, ymLabel } from "../format";
import { useSession } from "../session";
import { Modal } from "../ui/Modal";
import { Empty, Figure, Gauge, MonthPicker, Pill, RiskPill, Who } from "../ui/kit";

const RISK_ORDER = { ok: 0, warning: 1, violation: 2 } as const;

/** 勤怠は締め済みの前の月から見る（前の月が協定期間に無ければ当月）。currentYm は今日が属する月（締め日があれば翌月分のことがある） */
export function defaultYm(currentYm: string, fyStartMonth = 4): string {
  const [y, m] = currentYm.split("-").map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const fyStartYear = m >= fyStartMonth ? y : y - 1;
  return prev >= `${fyStartYear}-${String(fyStartMonth).padStart(2, "0")}` ? prev : currentYm;
}

// ---------------------------------------------------------------- 一覧

type SortKey = "name" | "days" | "work" | "ot" | "night" | "hol" | "risk";

export function Attendance({ go, ym, setYm }: { go: (to: string) => void; ym: string; setYm: (v: string) => void }) {
  const { data, error, loading } = useApi<AttendanceListResponse>(`/api/attendance?ym=${ym}`);
  const [dept, setDept] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "ot", dir: -1 });

  const rows = data?.rows ?? [];
  const depts = useMemo(() => [...new Set(rows.map((r) => r.emp.dept))], [rows]);

  const shown = useMemo(() => {
    const val = (x: AttendanceRow): number | string => {
      switch (sort.key) {
        case "name": return x.emp.id;
        case "days": return x.month.workDays;
        case "work": return x.month.workMin;
        case "ot": return x.month.overtimeMin;
        case "night": return x.month.nightMin;
        case "hol": return x.month.holidayMin;
        case "risk": return RISK_ORDER[x.risk.level] * 10000 + x.risk.outlook.projOvertime;
      }
    };
    return rows
      .filter((x) => (dept === "all" || x.emp.dept === dept) && (!q || x.emp.name.replace(/\s/g, "").includes(q.replace(/\s/g, ""))))
      .sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
      });
  }, [rows, dept, q, sort]);

  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;

  const current = ym === data.currentYm;
  const total = (f: (x: AttendanceRow) => number) => shown.reduce((s, x) => s + f(x), 0);
  const attention = shown.filter((x) => x.risk.level !== "ok").length;

  const th = (key: SortKey, label: string, right = false) => (
    <th className={right ? "r" : ""} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : -1 }))}>
        {label}
        {sort.key === key ? sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}
      </button>
    </th>
  );

  const [exporting, setExporting] = useState(false);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>勤怠一覧</h1>
          <p>
            {current ? "当月は前日までの実績で集計しています" : "月次の実績"}
            {rangeText(data.range)}
          </p>
        </div>
        <div className="tools">
          <MonthPicker months={data.months} value={ym} onChange={setYm} />
          <select className="field" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="部署で絞り込む">
            <option value="all">全部署</option>
            {depts.map((d) => <option key={d}>{d}</option>)}
          </select>
          <label className="search">
            <Search size={16} />
            <input className="field" placeholder="氏名で検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="氏名で検索" />
          </label>
          <button type="button" className="btn" onClick={() => setExporting(true)}><Download size={16} />給与用CSV</button>
        </div>
      </header>
      <ExportDialog open={exporting} ym={ym} onClose={() => setExporting(false)} />

      <div className={`stack ${loading ? "dim" : ""}`} aria-busy={loading}>
        <section className="figures" aria-label="月次サマリー">
          <Figure label="総労働時間" value={Math.round(total((x) => x.month.workMin) / 60).toLocaleString()} unit="時間" sub={`${shown.length}名の合計`} />
          <Figure label="時間外労働" value={Math.round(total((x) => x.month.overtimeMin) / 60)} unit="時間" sub={`1人あたり平均 ${hours1(shown.length ? total((x) => x.month.overtimeMin) / shown.length : 0)}時間`} />
          <Figure label="深夜労働" value={Math.round(total((x) => x.month.nightMin) / 60)} unit="時間" sub="22:00〜翌5:00" />
          <Figure label="法定休日労働" value={Math.round(total((x) => x.month.holidayMin) / 60)} unit="時間" sub="35%以上の割増対象" />
          <Figure label="36協定の注意" value={attention} unit="名" sub={current ? "月末見込ベース" : "月次実績ベース"} warn={attention > 0} hot={attention > 0} />
          <Figure label="要確認の打刻" value={total((x) => x.month.absentDays + x.month.incompleteDays)} unit="日" sub="打刻なし・退勤漏れ" warn={total((x) => x.month.absentDays + x.month.incompleteDays) > 0} />
        </section>

        <section className="panel">
          {shown.length === 0 ? (
            <Empty title="該当する社員がいません">部署や検索条件を変更してください。</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    {th("name", "社員")}
                    {th("days", "出勤日数", true)}
                    {th("work", "総労働", true)}
                    {th("ot", "時間外", true)}
                    {th("night", "深夜", true)}
                    {th("hol", "休日", true)}
                    <th className="r">有給残</th>
                    {th("risk", "36協定")}
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ emp, month: m, risk, leaveRemaining }) => (
                    <tr key={emp.id} className="clickable" tabIndex={0} onClick={() => go(`attendance/${emp.id}`)} onKeyDown={(ev) => ev.key === "Enter" && go(`attendance/${emp.id}`)}>
                      <td><Who name={emp.name} sub={`${emp.dept}・${emp.kind}`} /></td>
                      <td className="r">{m.workDays}<span style={{ color: "var(--ink-3)", fontSize: 12 }}> 日</span></td>
                      <td className="r">{dur(m.workMin)}</td>
                      <td className={`r ${m.overtimeMin > 45 * 60 ? "hot" : ""}`}>{dur(m.overtimeMin)}</td>
                      <td className={`r ${m.nightMin ? "" : "dim"}`}>{durOrDash(m.nightMin)}</td>
                      <td className={`r ${m.holidayMin ? "" : "dim"}`}>{durOrDash(m.holidayMin)}</td>
                      <td className="r">{leaveRemaining}<span style={{ color: "var(--ink-3)", fontSize: 12 }}> 日</span></td>
                      <td>
                        <RiskPill level={risk.level} />
                        {m.absentDays + m.incompleteDays > 0 ? <span style={{ marginLeft: 8 }}><Pill tone="warn">要確認 {m.absentDays + m.incompleteDays}日</Pill></span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className="note">時間外は日8時間超と週40時間超の合計（法定休日労働は含みません）。行を選ぶと日別の明細を表示します。</p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 個人明細

function dayLabel(p: DayPlan | undefined, date: string): { text: string; tone: "" | "ai" | "warn" | "bad" } {
  if (!p) return { text: "", tone: "" };
  switch (p.kind) {
    case "work": return p.note === "休日出勤" || p.note === "祝日出勤" ? { text: p.note, tone: "warn" } : { text: "出勤", tone: "" };
    case "leave": return { text: p.note ?? "有給休暇", tone: "ai" };
    case "off": return { text: p.note ?? (dowOf(date) === 0 || dowOf(date) === 6 ? "休み" : ""), tone: "" };
    case "absent": return { text: "打刻なし", tone: "bad" };
    case "incomplete": return { text: p.note ?? "要確認", tone: "warn" };
  }
}

export function AttendanceDetail({ id, go, ym, setYm }: { id: string; go: (to: string) => void; ym: string; setYm: (v: string) => void }) {
  const { isAdmin, me } = useSession();
  const { data, error, loading } = useApi<AttendanceDetailResponse>(`/api/attendance/${encodeURIComponent(id)}?ym=${ym}`);
  if (!data) return <p className={error ? "status-error" : ""} role="status">{error ?? "読み込んでいます…"}</p>;

  const { emp, month: m, risk, today, period } = data;
  const byDate = new Map(data.days.map((d) => [d.plan.date, d]));
  const variable = emp.workStyle !== "fixed";
  // 対象期間が3か月を超える1年単位の変形労働時間制は、36協定の限度が月42時間・年320時間
  const monthLimit = emp.workStyle === "yearly" ? 42 : 45;
  const yearLimit = emp.workStyle === "yearly" ? 320 : 360;

  const exportCsv = () =>
    csvDownload(`勤怠明細_${emp.name.replace(/\s/g, "")}_${ym}.csv`, [
      ["日付", "区分", "出勤", "退勤", "休憩(分)", "実働(分)", "法定内(分)", variable ? "時間外(分)" : "日単位時間外(分)", "深夜(分)", "法定休日(分)"],
      ...data.days.map(({ plan: p, result: r }) => [
        p.date, dayLabel(p, p.date).text, p.start !== undefined ? clock(p.start) : "", p.end !== undefined && p.kind === "work" ? clock(p.end) : "",
        p.breaks.reduce((s, b) => s + b.end - b.start, 0) || "", r?.workMin ?? "", r?.legalInMin ?? "", r?.dailyOvertimeMin ?? "", r?.nightMin ?? "", r?.legalHolidayMin ?? "",
      ]),
    ]);

  return (
    <>
      {isAdmin ? (
        <a className="back" href="#/attendance" onClick={(e) => { e.preventDefault(); go("attendance"); }}>
          <ChevronLeft size={16} />勤怠一覧
        </a>
      ) : null}
      <header className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="avatar" style={{ width: 44, height: 44, fontSize: 18 }} aria-hidden="true">{emp.name.charAt(0)}</span>
          <div>
            <h1>{emp.name}</h1>
            <p>
              {emp.dept}{emp.title ? `・${emp.title}` : ""}・{emp.kind}（週{emp.weeklyDays}日／{emp.weeklyHours}時間）{rangeText(data.range)}
              {variable ? <span style={{ marginLeft: 8 }}><Pill tone="live" plain>{WORK_STYLE_LABEL[emp.workStyle]}</Pill></span> : null}
            </p>
          </div>
        </div>
        <div className="tools">
          <MonthPicker months={data.months} value={ym} onChange={setYm} />
          <button type="button" className="btn" onClick={exportCsv}><Download size={16} />CSV出力</button>
        </div>
      </header>

      <div className={`stack ${loading ? "dim" : ""}`} aria-busy={loading}>
        <section className="figures" aria-label="月次サマリー">
          <Figure label="出勤日数" value={m.workDays} unit="日" sub={m.leaveDays ? `有給 ${m.leaveDays}日` : "有給なし"} />
          <Figure label="総労働時間" value={dur(m.workMin)} sub="休憩を除く実働" />
          <Figure label="時間外労働" value={dur(m.overtimeMin)} sub={overtimeSub(m, variable)} hot={m.overtimeMin > monthLimit * 60} />
          <Figure label="深夜労働" value={dur(m.nightMin)} sub="22:00〜翌5:00" />
          <Figure label="法定休日労働" value={dur(m.holidayMin)} sub="法定休日の勤務" />
          <Figure label="要確認の打刻" value={m.absentDays + m.incompleteDays} unit="日" sub="打刻なし・退勤漏れ" warn={m.absentDays + m.incompleteDays > 0} hot={m.absentDays + m.incompleteDays > 0} />
        </section>

        {period ? <PeriodPanel p={period} today={today} /> : null}

        <div className="cols-2">
          <section className="panel" aria-labelledby="chart-t">
            <div className="panel-head">
              <h2 id="chart-t">月別の時間外労働<span className="sub">{ymLabel(data.months[0]!)}〜（協定期間）</span></h2>
              <span className="legend"><span>破線は月{monthLimit}時間</span></span>
            </div>
            <div className="panel-body"><OvertimeChart series={data.series} selected={ym} currentYm={data.currentYm} limitHours={monthLimit} /></div>
          </section>
          <section className="panel" aria-labelledby="al-t">
            <div className="panel-head">
              <h2 id="al-t">36協定のチェック</h2>
              <RiskPill level={risk.level} />
            </div>
            <div className="panel-body">
              {risk.alerts.length === 0 ? (
                <p style={{ margin: 0, color: "var(--ink-2)" }}>基準内です。年の時間外累計は {hours1(risk.yearOvertime)}時間、月{monthLimit}時間超は {risk.over45Count}回です。</p>
              ) : (
                <ul className="alert-list">
                  {risk.alerts.map((a, i) => (
                    <li key={i}>
                      <Pill tone={a.level === "violation" ? "bad" : "warn"}>{a.level === "violation" ? "違反" : "注意"}</Pill>
                      <span>{a.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              <dl className="kv" style={{ marginTop: 10 }}>
                <div><dt>年の時間外累計（{me.settings.specialClause ? "特別条項の上限720時間" : `上限${yearLimit}時間`}）</dt><dd>{hours1(risk.yearOvertime)}h</dd></div>
                <div><dt>月{monthLimit}時間超の回数（特別条項は年6回まで）</dt><dd>{risk.over45Count}回</dd></div>
                <div><dt>{ym === data.currentYm ? "月末見込" : "当月実績"}</dt><dd>{hours1(risk.outlook.projOvertime)}h</dd></div>
              </dl>
            </div>
          </section>
        </div>

        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>日付</th><th>区分</th><th className="r">出勤</th><th className="r">退勤</th><th className="r">休憩</th>
                  <th className="r">実働</th><th className="r">法定内</th><th className="r">{variable ? "時間外" : "時間外（日）"}</th><th className="r">深夜</th><th>備考</th>
                </tr>
              </thead>
              <tbody>
                {datesBetween(data.range.from, data.range.to).map((d) => {
                  const row = byDate.get(d);
                  const p = row?.plan;
                  const r = row?.result;
                  const w = dowOf(d);
                  const rest = p ? p.kind === "off" || p.kind === "leave" : w === 0 || w === 6;
                  const lab = dayLabel(p, d);
                  const cls = d === today ? "today" : rest ? "rest" : "";
                  const closed = p?.kind === "work";
                  return (
                    <tr key={d} className={cls}>
                      <td className={w === 0 ? "sun" : w === 6 ? "sat" : ""}>{shortDate(d)}（{WD[w]}）</td>
                      <td>{d === today ? <Pill tone="live" plain>本日・集計前</Pill> : lab.text ? <Pill tone={lab.tone} plain>{lab.text}</Pill> : null}</td>
                      <td className="r">{p?.start !== undefined ? clock(p.start) : ""}</td>
                      <td className="r">{closed && p?.end !== undefined ? clock(p.end) : ""}</td>
                      <td className="r">{p && p.breaks.length ? dur(p.breaks.reduce((s, b) => s + b.end - b.start, 0)) : ""}</td>
                      <td className="r">{r ? dur(r.workMin) : ""}</td>
                      <td className="r">{r ? durOrDash(r.legalInMin) : ""}</td>
                      <td className={`r ${r && r.dailyOvertimeMin > 120 ? "hot" : ""}`}>{r ? durOrDash(r.dailyOvertimeMin) : ""}</td>
                      <td className="r">{r ? durOrDash(r.nightMin) : ""}</td>
                      <td style={{ color: "var(--ink-3)" }}>{p?.kind === "work" && p.note && p.note !== lab.text ? p.note : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>合計</td>
                  <td className="r">{dur(m.workMin)}</td>
                  <td className="r">{dur(m.legalInMin)}</td>
                  <td className="r">{dur(m.overtimeMin)}</td>
                  <td className="r">{dur(m.nightMin)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
        <p className="note">
          {m.rounded ? "時間外・深夜・法定休日の月合計は、会社の設定により30分単位で丸めています（30分未満切捨・以上切上）。下の日別の合計とは一致しないことがあります。" : null}
          {variable
            ? "日別の「時間外」は、その日に新たに発生した時間外（日・週・期間の判定の合計）です。週・期間の超過は、超えた日に付きます。本日は集計前です。"
            : `合計の時間外には、週40時間を超えた分${m.weeklyOvertimeMin ? `（${dur(m.weeklyOvertimeMin)}）` : ""}を含みます。日別の欄は日8時間超のみを表示します。`}
        </p>
      </div>
    </>
  );
}

/** 全社員ぶんの月次CSV（給与計算用） */
function ExportDialog({ open, ym, onClose }: { open: boolean; ym: string; onClose: () => void }) {
  const [kind, setKind] = useState<"summary" | "detail">("summary");
  const [time, setTime] = useState<"hm" | "decimal">("hm");
  return (
    <Modal open={open} onClose={onClose} title={`${ymLabel(ym)}の勤怠CSV（全社員）`}>
      <div className="form">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, color: "var(--ink-2)", padding: 0, marginBottom: 5 }}>内容</legend>
          <div className="radio-row">
            <label><input type="radio" name="ek" checked={kind === "summary"} onChange={() => setKind("summary")} />社員ごとの月次集計</label>
            <label><input type="radio" name="ek" checked={kind === "detail"} onChange={() => setKind("detail")} />日別の明細</label>
          </div>
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, color: "var(--ink-2)", padding: 0, marginBottom: 5 }}>時間の表記</legend>
          <div className="radio-row">
            <label><input type="radio" name="et" checked={time === "hm"} onChange={() => setTime("hm")} />時:分（例 12:30）</label>
            <label><input type="radio" name="et" checked={time === "decimal"} onChange={() => setTime("decimal")} />小数の時間（例 12.50）</label>
          </div>
        </fieldset>
        <p className="note" style={{ margin: 0 }}>給与ソフトごとの取り込み形式には合わせていません。取り込み側の項目に合わせて、列を並べ替えて使ってください。月合計の端数処理は、会社設定に従います。</p>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>閉じる</button>
          <a className="btn primary" href={`/api/attendance/export?ym=${ym}&kind=${kind}&time=${time}`} download onClick={() => setTimeout(onClose, 300)}><Download size={16} />ダウンロード</a>
        </div>
      </div>
    </Modal>
  );
}

/** 締め日がある会社は、月の期間を示す（暦月どおりなら示さない） */
function rangeText(r: { from: string; to: string }): string {
  const calendar = r.from.slice(8) === "01" && r.from.slice(0, 7) === r.to.slice(0, 7);
  return calendar ? "" : `（対象期間 ${shortDate(r.from)}〜${shortDate(r.to)}）`;
}

/** 時間外の内訳の表示 */
function overtimeSub(m: AttendanceDetailResponse["month"], variable: boolean): string {
  if (!variable) return m.weeklyOvertimeMin ? `うち週40時間超 ${dur(m.weeklyOvertimeMin)}` : "日8時間超の合計";
  const parts = [`日 ${dur(m.overtimeMin - m.weeklyOvertimeMin - m.periodOvertimeMin)}`];
  if (m.weeklyOvertimeMin) parts.push(`週 ${dur(m.weeklyOvertimeMin)}`);
  if (m.periodOvertimeMin) parts.push(`期間 ${dur(m.periodOvertimeMin)}`);
  return `内訳: ${parts.join(" / ")}`;
}

const STYLE_PERIOD: Record<string, string> = { monthly: "変形期間", yearly: "変形期間（1年）", weekly: "変形期間（週）", flex: "清算期間" };

/** 変形期間・清算期間の進み具合: 実労働を、法定労働時間の総枠と、所定労働時間と比べる */
function PeriodPanel({ p, today }: { p: NonNullable<AttendanceDetailResponse["period"]>; today: string }) {
  const frameH = p.frameMin / 60;
  const diff = p.workMin - p.contractSoFarMin;
  const level = p.workMin > p.frameMin ? "violation" : p.workMin > p.frameMin * 0.9 ? "warning" : "ok";
  const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "±") + dur(Math.abs(n));
  return (
    <section className="panel" aria-labelledby="per-t">
      <div className="panel-head">
        <h2 id="per-t">{STYLE_PERIOD[p.style] ?? "期間"}の状況<span className="sub">{p.start.replace(/-/g, "/")} 〜 {p.end.replace(/-/g, "/")}</span></h2>
        {p.end >= today ? <Pill tone="live" plain>残り{p.remainingDays}日</Pill> : <Pill plain>終了</Pill>}
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        <div className="gauge-cell">
          <Gauge mtd={p.workMin} proj={p.workMin} scaleHours={Math.max(frameH * 1.15, p.workMin / 60 * 1.05)} tickHours={frameH} level={level} />
          <span className="num">{dur(p.workMin)}</span>
        </div>
        <p className="note" style={{ margin: 0 }}>縦線は法定労働時間の総枠（{dur(p.frameMin)}）です。総枠を超えた分が、時間外になります。</p>
        <dl className="kv">
          <div><dt>実労働（法定休日の勤務を除く）</dt><dd>{dur(p.workMin)}</dd></div>
          <div><dt>法定労働時間の総枠</dt><dd>{dur(p.frameMin)}</dd></div>
          <div><dt>総枠までの残り</dt><dd>{p.workMin > p.frameMin ? `超過 ${dur(p.workMin - p.frameMin)}` : dur(p.frameMin - p.workMin)}</dd></div>
          <div><dt>所定労働時間（期間全体）</dt><dd>{dur(p.contractMin)}</dd></div>
          <div><dt>前日までの所定との差</dt><dd>{sign(diff)}</dd></div>
          <div><dt>期間内の時間外（ここまで）</dt><dd>{dur(p.overtimeMin)}</dd></div>
        </dl>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 月別グラフ

function OvertimeChart({ series, selected, currentYm, limitHours = 45 }: { series: { ym: string; actual: number; proj: number }[]; selected: string; currentYm: string; limitHours?: number }) {
  const W = 560;
  const H = 210;
  const pad = { l: 34, r: 8, t: 14, b: 26 };
  const max = Math.max(80 * 60, ...series.map((d) => d.proj)) * 1.05;
  const bw = (W - pad.l - pad.r) / Math.max(series.length, 1);
  const y = (min: number) => pad.t + (H - pad.t - pad.b) * (1 - min / max);
  const ticks = [0, 20, limitHours, 60, 80].filter((t) => t * 60 <= max);

  return (
    <svg className="bars-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="月別の時間外労働時間">
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#1d3a5c" fillOpacity="0.14" />
          <rect width="3" height="6" fill="#1d3a5c" fillOpacity="0.4" />
        </pattern>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t * 60)} y2={y(t * 60)} stroke={t === limitHours ? "#16202a" : "#ebeef0"} strokeDasharray={t === limitHours ? "4 3" : undefined} strokeWidth={t === limitHours ? 1.2 : 1} />
          <text x={pad.l - 6} y={y(t * 60) + 4} textAnchor="end" fontSize="11" fill="#6f7b86" fontFamily="Barlow Semi Condensed, sans-serif">{t}</text>
        </g>
      ))}
      {series.map((d, i) => {
        const x = pad.l + i * bw + bw * 0.2;
        const w = bw * 0.6;
        const color = d.proj > 80 * 60 ? "#c42b40" : d.proj > limitHours * 60 ? "#e3a008" : "#1d3a5c";
        return (
          <g key={d.ym} opacity={d.ym === selected ? 1 : 0.62}>
            {d.ym === currentYm ? (
              <>
                <rect x={x} y={y(d.proj)} width={w} height={Math.max(1, y(0) - y(d.proj))} fill="url(#hatch)" stroke={color} strokeOpacity="0.5" />
                <rect x={x} y={y(d.actual)} width={w} height={y(0) - y(d.actual)} fill={color} />
              </>
            ) : (
              <rect x={x} y={y(d.proj)} width={w} height={Math.max(1, y(0) - y(d.proj))} fill={color} />
            )}
            <text x={x + w / 2} y={y(d.proj) - 4} textAnchor="middle" fontSize="12" fontWeight="600" fill="#16202a" fontFamily="Barlow Semi Condensed, sans-serif">{(d.proj / 60).toFixed(0)}</text>
            <text x={x + w / 2} y={H - 8} textAnchor="middle" fontSize="12" fill="#46525e">{Number(d.ym.slice(5))}月</text>
          </g>
        );
      })}
    </svg>
  );
}

