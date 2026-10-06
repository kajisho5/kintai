import { useState } from "react";
import { CalendarCheck, ClipboardCheck, Clock3, KeyRound, LayoutGrid, LogOut, Table2 } from "lucide-react";
import { SessionProvider, useSession } from "./session";
import { useHashRoute } from "./ui/hooks";
import { Avatar } from "./ui/kit";
import { PasswordDialog } from "./ui/PasswordDialog";
import { Approvals } from "./pages/Approvals";
import { Attendance, AttendanceDetail, defaultYm } from "./pages/Attendance";
import { Dashboard } from "./pages/Dashboard";
import { Leave } from "./pages/Leave";
import { Punch } from "./pages/Punch";

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#1d3a5c" />
      <path d="M7 22 L14 12 L18 17 L25 8" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="8" r="2.4" fill="#0f8a94" stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

function Shell() {
  const { me, isAdmin, logout } = useSession();
  const [route, go] = useHashRoute();
  const [ym, setYm] = useState(() => defaultYm(me.today));
  const [pwOpen, setPwOpen] = useState(false);
  const myId = me.employee.id;

  const nav = isAdmin
    ? [
        { to: "dashboard", label: "ダッシュボード", icon: LayoutGrid },
        { to: "punch", label: "打刻", icon: Clock3 },
        { to: "attendance", label: "勤怠一覧", icon: Table2 },
        { to: "approvals", label: "申請・承認", icon: ClipboardCheck },
        { to: "leave", label: "有給管理", icon: CalendarCheck },
      ]
    : [
        { to: "punch", label: "打刻", icon: Clock3 },
        { to: `attendance/${myId}`, label: "自分の勤怠", icon: Table2 },
        { to: "approvals", label: "申請", icon: ClipboardCheck },
        { to: "leave", label: "有給", icon: CalendarCheck },
      ];

  const [section = "", param] = (route || (isAdmin ? "dashboard" : "punch")).split("/");

  let page;
  switch (section) {
    case "punch": page = <Punch />; break;
    case "attendance":
      page = !isAdmin ? <AttendanceDetail id={myId} go={go} ym={ym} setYm={setYm} />
        : param ? <AttendanceDetail id={param} go={go} ym={ym} setYm={setYm} /> : <Attendance go={go} ym={ym} setYm={setYm} />;
      break;
    case "approvals": page = <Approvals />; break;
    case "leave": page = <Leave />; break;
    default: page = isAdmin ? <Dashboard go={go} /> : <Punch />;
  }
  const activeKey = section === "attendance" && !isAdmin ? `attendance/${myId}` : section;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Kintai</div>
            <div className="brand-co">勤怠管理</div>
          </div>
        </div>
        <nav className="nav" aria-label="メイン">
          {nav.map(({ to, label, icon: Icon }) => (
            <a key={to} href={`#/${to}`} aria-current={activeKey === to ? "page" : undefined}>
              <Icon size={19} aria-hidden="true" />
              {label}
              {to === "approvals" && me.pending > 0 ? <span className="badge" aria-label={`${me.pending}件`}>{me.pending}</span> : null}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <Avatar name={me.employee.name} />
          <div>
            <b>{me.employee.name}</b>
            <small>{isAdmin ? "管理者" : me.employee.dept}</small>
          </div>
          <button type="button" className="btn sm text" onClick={() => setPwOpen(true)} aria-label="パスワードを変更" title="パスワードを変更"><KeyRound size={16} /></button>
          <button type="button" className="btn sm text" onClick={() => void logout()} aria-label="ログアウト" title="ログアウト"><LogOut size={16} /></button>
        </div>
      </aside>
      <main className="main">
        <div className="mobile-logout">
          <button type="button" className="btn sm text" onClick={() => setPwOpen(true)}><KeyRound size={14} />パスワード変更</button>
          <button type="button" className="btn sm text" onClick={() => void logout()}><LogOut size={14} />ログアウト</button>
        </div>
        {page}
      </main>
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}
