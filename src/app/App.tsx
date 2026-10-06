import { CalendarCheck, ClipboardCheck, Clock3, LayoutGrid, Table2 } from "lucide-react";
import { useState } from "react";
import { COMPANY, FY_MONTHS, ME, REQUESTS } from "./data";
import { useStore } from "./store";
import { useHashRoute } from "./ui/hooks";
import { Avatar } from "./ui/kit";
import { Approvals } from "./pages/Approvals";
import { Attendance, AttendanceDetail } from "./pages/Attendance";
import { Dashboard } from "./pages/Dashboard";
import { Leave } from "./pages/Leave";
import { Punch } from "./pages/Punch";

const NAV = [
  { to: "dashboard", label: "ダッシュボード", icon: LayoutGrid },
  { to: "punch", label: "打刻", icon: Clock3 },
  { to: "attendance", label: "勤怠一覧", icon: Table2 },
  { to: "approvals", label: "申請・承認", icon: ClipboardCheck },
  { to: "leave", label: "有給管理", icon: CalendarCheck },
] as const;

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#1d3a5c" />
      <path d="M7 22 L14 12 L18 17 L25 8" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="8" r="2.4" fill="#0f8a94" stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

export function App() {
  const [route, go] = useHashRoute();
  const { decisions } = useStore();
  const pending = REQUESTS.filter((r) => (decisions[r.id] ?? r.initial) === "pending").length;
  const [section, param] = route.split("/");
  // 勤怠は締め済みの前月から見る（前月がなければ当月）
  const [ym, setYm] = useState(FY_MONTHS[FY_MONTHS.length - 2] ?? FY_MONTHS[FY_MONTHS.length - 1]!);

  let page;
  switch (section) {
    case "punch": page = <Punch />; break;
    case "attendance": page = param ? <AttendanceDetail id={param} go={go} ym={ym} setYm={setYm} /> : <Attendance go={go} ym={ym} setYm={setYm} />; break;
    case "approvals": page = <Approvals />; break;
    case "leave": page = <Leave />; break;
    default: page = <Dashboard go={go} />;
  }

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Kintai</div>
            <div className="brand-co">{COMPANY}</div>
          </div>
        </div>
        <nav className="nav" aria-label="メイン">
          {NAV.map(({ to, label, icon: Icon }) => (
            <a key={to} href={`#/${to}`} aria-current={(section || "dashboard") === to ? "page" : undefined}>
              <Icon size={19} aria-hidden="true" />
              {label}
              {to === "approvals" && pending > 0 ? <span className="badge" aria-label={`${pending}件`}>{pending}</span> : null}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <Avatar name={ME.name} />
          <div>
            <b>{ME.name}</b>
            <small>人事総務（管理者）</small>
          </div>
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}
