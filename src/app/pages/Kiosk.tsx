import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Coffee, CornerDownLeft, Delete, LogIn, LogOut, Play } from "lucide-react";
import type { KioskHello, KioskIdentified, KioskPunched } from "../../domain/api";
import type { PunchKind } from "../../domain/types";
import { ApiError, api } from "../api";
import { clock as fmtClock, jpDate } from "../format";
import { BrandMark } from "../ui/BrandMark";
import { BRAND } from "../../brand";

const STORE = "kiosk-token";
const LABEL: Record<PunchKind, string> = { in: "出勤", out: "退勤", break_start: "休憩開始", break_end: "休憩終了" };
const ICON: Record<PunchKind, typeof LogIn> = { in: LogIn, out: LogOut, break_start: Coffee, break_end: Play };

const readToken = (): string | undefined => {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("t");
  try {
    if (q) {
      localStorage.setItem(STORE, q); // 端末に保存し、URL からは消す（画面の共有・履歴にトークンを残さない）
      window.history.replaceState(null, "", `${window.location.pathname}#/kiosk`);
      return q;
    }
    return localStorage.getItem(STORE) ?? undefined;
  } catch {
    return q ?? undefined;
  }
};

type Step = { kind: "idle" } | { kind: "who"; id: KioskIdentified } | { kind: "done"; r: KioskPunched };

/** 共用の打刻端末。ログインせず、端末のトークンで動く。社員はICカード（読み取り機のキー入力）か、社員ID＋暗証番号で本人確認する */
export function Kiosk() {
  const [token] = useState(readToken);
  const [hello, setHello] = useState<KioskHello | null>(null);
  const [fatal, setFatal] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [empId, setEmpId] = useState("");
  const [pin, setPin] = useState("");
  const [field, setField] = useState<"id" | "pin">("id");
  const [offset, setOffset] = useState(0); // サーバーの時刻との差（端末の時計は使わない）
  const [tick, setTick] = useState(0);
  const cardBuf = useRef({ text: "", at: 0 });
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reset = useCallback(() => {
    clearTimeout(resetTimer.current);
    setStep({ kind: "idle" });
    setEmpId("");
    setPin("");
    setField("id");
    setError("");
  }, []);

  useEffect(() => {
    if (!token) return;
    const t0 = performance.now();
    api<KioskHello>("/api/kiosk/hello", { method: "POST", body: { token } })
      .then((h) => {
        setHello(h);
        setOffset(h.nowMin * 60_000 - t0); // performance.now() との差
      })
      .catch((e) => setFatal(e instanceof Error ? e.message : "接続できません"));
  }, [token]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 結果・確認の画面は、しばらくしたら自動で待ち受けに戻る
  useEffect(() => {
    if (step.kind === "idle") return;
    resetTimer.current = setTimeout(reset, step.kind === "done" ? 6000 : 30_000);
    return () => clearTimeout(resetTimer.current);
  }, [step, reset]);

  const identify = useCallback(
    async (body: { card?: string; empId?: string; pin?: string }) => {
      if (!token) return;
      setBusy(true);
      setError("");
      try {
        const id = await api<KioskIdentified>("/api/kiosk/identify", { method: "POST", body: { token, ...body } });
        setStep({ kind: "who", id });
        setPin("");
        setEmpId("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "確認できませんでした");
        setPin("");
        if (e instanceof ApiError && e.status === 401 && /端末/.test(e.message)) setFatal(e.message);
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  // ICカードの読み取り機は、番号を高速にキー入力して Enter を送る。入力欄の外でも拾う
  useEffect(() => {
    if (step.kind !== "idle") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" && (target as HTMLInputElement).dataset.manual) return;
      const now = performance.now();
      if (now - cardBuf.current.at > 80) cardBuf.current.text = ""; // キー入力の間隔が空いたら、人の入力とみなして捨てる
      cardBuf.current.at = now;
      if (e.key === "Enter") {
        const text = cardBuf.current.text;
        cardBuf.current.text = "";
        if (text.length >= 4) void identify({ card: text });
      } else if (e.key.length === 1) cardBuf.current.text += e.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step.kind, identify]);

  const punch = async (action: PunchKind) => {
    if (step.kind !== "who" || !token) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<KioskPunched>("/api/kiosk/punch", { method: "POST", body: { token, ticket: step.id.ticket, action } });
      setStep({ kind: "done", r });
    } catch (e) {
      setError(e instanceof Error ? e.message : "打刻できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (field === "id") {
      if (empId.trim()) setField("pin");
    } else if (empId.trim() && pin) void identify({ empId: empId.trim(), pin });
  };
  const press = (d: string) => {
    if (field === "pin") setPin((p) => (p + d).slice(0, 12));
    else setEmpId((p) => (p + d).slice(0, 30));
  };

  void tick;
  const nowMin = hello ? (performance.now() + offset) / 60_000 : 0;
  const total = Math.floor(((nowMin % 1440) + 1440) % 1440 * 60);
  const p2 = (n: number) => String(n).padStart(2, "0");

  if (!token || fatal) {
    return (
      <main className="kiosk">
        <div className="kiosk-card">
          <h1>{fatal ? "この端末は使えません" : "端末が登録されていません"}</h1>
          <p>{fatal || "管理者が発行した、端末登録用のURLを開いてください（会社設定の「共用の打刻端末」）。"}</p>
        </div>
      </main>
    );
  }
  if (!hello) return <main className="kiosk"><div className="splash" role="status" aria-label="読み込み中" /></main>;

  return (
    <main className="kiosk">
      <header className="kiosk-head">
        <div className="brand" style={{ padding: 0 }}>
          <BrandMark />
          <div>
            <div className="brand-name">{BRAND.name}</div>
            <div className="brand-co">{hello.company}・{hello.terminal}</div>
          </div>
        </div>
        <div className="kiosk-clock" aria-label={`現在時刻 ${p2(Math.floor(total / 3600))}時${p2(Math.floor((total % 3600) / 60))}分`}>
          <b className="num">{p2(Math.floor(total / 3600))}:{p2(Math.floor((total % 3600) / 60))}<span>{p2(total % 60)}</span></b>
          <small>{jpDate(hello.today)}</small>
        </div>
      </header>

      {!hello.writable ? <div className="banner bad" role="alert">契約が有効ではないため、打刻できません。管理者にご連絡ください。</div> : null}

      {step.kind === "idle" ? (
        <section className="kiosk-card" aria-label="本人確認">
          <h1>{field === "id" ? "社員IDを入力、またはカードをかざしてください" : "暗証番号を入力してください"}</h1>
          <form onSubmit={submit} className="kiosk-form">
            <label>
              社員ID
              <input className="field" data-manual="1" value={empId} onChange={(e) => setEmpId(e.target.value)} onFocus={() => setField("id")} autoCapitalize="none" autoComplete="off" inputMode="text" aria-label="社員ID" />
            </label>
            <label>
              暗証番号
              <input className="field" data-manual="1" type="password" value={pin} onChange={(e) => setPin(e.target.value)} onFocus={() => setField("pin")} autoComplete="off" inputMode="numeric" aria-label="暗証番号" />
            </label>
            <div className="keypad" role="group" aria-label="テンキー">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} type="button" onClick={() => press(d)}>{d}</button>)}
              <button type="button" onClick={() => (field === "pin" ? setPin((p) => p.slice(0, -1)) : setEmpId((p) => p.slice(0, -1)))} aria-label="1文字消す"><Delete size={22} /></button>
              <button type="button" onClick={() => press("0")}>0</button>
              <button type="submit" className="go" disabled={busy || !empId.trim() || (field === "pin" && !pin)} aria-label="確認"><CornerDownLeft size={22} /></button>
            </div>
          </form>
          <div className="form-error" role="alert">{error}</div>
        </section>
      ) : null}

      {step.kind === "who" ? (
        <section className="kiosk-card" aria-label="打刻の選択">
          <h1>{step.id.emp.name} さん</h1>
          <p className="note" style={{ margin: 0 }}>{step.id.emp.dept}　{step.id.phase === "before" ? "出勤前" : step.id.phase === "working" ? `勤務中（出勤 ${fmtClock(step.id.events.in!)}）` : step.id.phase === "break" ? "休憩中" : `退勤済（${fmtClock(step.id.events.out!)}）`}</p>
          <div className="kiosk-actions">
            {step.id.allowed.length === 0 ? <p>本日の勤務は終了しています。</p> : null}
            {step.id.allowed.map((a) => {
              const Icon = ICON[a];
              return (
                <button key={a} type="button" className={`pbtn ${a === "in" || a === "out" ? "main-act" : ""}`} disabled={busy || !hello.writable} onClick={() => void punch(a)}>
                  <span className="ic"><Icon size={28} /></span>
                  <span><b>{LABEL[a]}</b></span>
                </button>
              );
            })}
          </div>
          <div className="form-error" role="alert">{error}</div>
          <button type="button" className="btn" onClick={reset}>キャンセル</button>
        </section>
      ) : null}

      {step.kind === "done" ? (
        <section className="kiosk-card done" role="status" aria-live="polite">
          <h1>{step.r.emp.name} さん</h1>
          <p className="kiosk-result"><b>{LABEL[step.r.action]}</b>を記録しました <span className="num">{fmtClock(step.r.at)}</span></p>
          <button type="button" className="btn primary" onClick={reset}>OK</button>
        </section>
      ) : null}
    </main>
  );
}
