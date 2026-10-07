import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { RiskLevel } from "../../domain/types";

export function Pill({ tone = "", children, plain }: { tone?: "ok" | "warn" | "bad" | "ai" | "live" | ""; children: ReactNode; plain?: boolean }) {
  return <span className={`pill ${tone} ${plain ? "plain" : ""}`}>{children}</span>;
}

export const RISK_PILL: Record<RiskLevel, { tone: "ok" | "warn" | "bad"; label: string }> = {
  ok: { tone: "ok", label: "良好" },
  warning: { tone: "warn", label: "注意" },
  violation: { tone: "bad", label: "違反の恐れ" },
};

export function RiskPill({ level }: { level: RiskLevel }) {
  const r = RISK_PILL[level];
  return <Pill tone={r.tone}>{r.label}</Pill>;
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {name.charAt(0)}
    </span>
  );
}

export function Who({ name, sub }: { name: string; sub?: string }) {
  return (
    <span className="who">
      <Avatar name={name} />
      <span>
        <b>{name}</b>
        {sub ? <small>{sub}</small> : null}
      </span>
    </span>
  );
}

export function Figure({ label, value, unit, sub, warn, hot }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; warn?: boolean; hot?: boolean }) {
  return (
    <div className={`figure ${hot ? "hot" : ""}`} role="group" aria-label={label}>
      <dl style={{ margin: 0 }}>
        <dt>{label}</dt>
        <dd>
          <div className="v">
            {value}
            {unit ? <small>{unit}</small> : null}
          </div>
          <div className={`s ${warn ? "warn" : ""}`}>{sub}</div>
        </dd>
      </dl>
    </div>
  );
}

/** 時間外の累計（実線）と月末見込（斜線）を、上限の目盛り付きで表示 */
export function Gauge({ mtd, proj, scaleHours, tickHours, level }: { mtd: number; proj: number; scaleHours: number; tickHours: number; level: RiskLevel }) {
  const pct = (min: number) => `${Math.min(100, (min / (scaleHours * 60)) * 100)}%`;
  return (
    <div className={`gauge ${level}`} role="img" aria-label={`累計 ${(mtd / 60).toFixed(1)}時間、見込 ${(proj / 60).toFixed(1)}時間、基準 ${tickHours}時間`}>
      <div className="proj" style={{ width: pct(Math.max(proj, mtd)) }} />
      <div className="fill" style={{ width: pct(mtd) }} />
      <div className="tick" style={{ left: pct(tickHours * 60) }} />
    </div>
  );
}

export function MonthPicker({ months, value, onChange }: { months: string[]; value: string; onChange: (ym: string) => void }) {
  const i = months.indexOf(value);
  const [y, m] = value.split("-");
  return (
    <div className="monthpick" role="group" aria-label="対象月">
      <button type="button" aria-label="前の月" disabled={i <= 0} onClick={() => onChange(months[i - 1]!)}>
        <ChevronLeft size={18} />
      </button>
      <span>
        {y}年{Number(m)}月
      </span>
      <button type="button" aria-label="次の月" disabled={i >= months.length - 1} onClick={() => onChange(months[i + 1]!)}>
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}
