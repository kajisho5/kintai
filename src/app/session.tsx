import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { MeResponse } from "../domain/api";
import { api } from "./api";
import { Login } from "./pages/Login";

interface Base {
  me: MeResponse;
  /** me を受け取った時点の performance.now() */
  at: number;
}

interface Session {
  me: MeResponse;
  isAdmin: boolean;
  refresh: () => void;
  logout: () => Promise<void>;
  base: Base;
}

const Ctx = createContext<Session | null>(null);

export const useSession = (): Session => {
  const s = useContext(Ctx);
  if (!s) throw new Error("SessionProvider の外では使えません");
  return s;
};

/** サーバー（会社のタイムゾーン）基準の現在時刻。ブラウザのタイムゾーンに依存しない */
export function useClock(): { today: string; min: number; hh: string; mm: string; ss: string } {
  const { base, refresh } = useSession();
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const min = base.me.nowMin + (performance.now() - base.at) / 60000;
  useEffect(() => {
    if (min >= 1440) refresh(); // 日付をまたいだら取得し直す
  }, [min >= 1440]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = Math.floor(Math.min(min, 1439.99) * 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return { today: base.me.today, min, hh: p(Math.floor(total / 3600)), mm: p(Math.floor((total % 3600) / 60)), ss: p(total % 60) };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "anon" } | { status: "authed"; base: Base }>({ status: "loading" });

  const load = useCallback(() => {
    api<MeResponse>("/api/me")
      .then((me) => setState({ status: "authed", base: { me, at: performance.now() } }))
      .catch(() => setState({ status: "anon" }));
  }, []);

  useEffect(() => {
    load();
    const off = () => setState({ status: "anon" });
    window.addEventListener("kintai:unauthorized", off);
    return () => window.removeEventListener("kintai:unauthorized", off);
  }, [load]);

  if (state.status === "loading") return <div className="splash" role="status" aria-label="読み込み中" />;
  if (state.status === "anon") return <Login onLogin={load} />;

  const session: Session = {
    me: state.base.me,
    isAdmin: state.base.me.employee.role === "admin",
    base: state.base,
    refresh: load,
    logout: async () => {
      await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      setState({ status: "anon" });
    },
  };
  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}
