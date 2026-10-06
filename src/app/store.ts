import { useSyncExternalStore } from "react";
import { ymd } from "./format";

export interface PunchEvents {
  in?: number;
  out?: number;
  breaks: { start: number; end?: number }[];
}

export interface PunchState {
  date: string;
  events: PunchEvents;
}

export type Decision = "approved" | "rejected";

interface State {
  punch: PunchState;
  decisions: Record<string, Decision>;
}

const KEY = "kintai.demo.v1";
const today = () => ymd(new Date());
const fresh = (): State => ({ punch: { date: today(), events: { breaks: [] } }, decisions: {} });

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      if (s.punch.date !== today()) s.punch = fresh().punch;
      return s;
    }
  } catch {
    /* 保存領域が使えない環境では毎回初期状態から始める */
  }
  return fresh();
}

let state: State = load();
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 保存できなくても画面操作は継続する */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useStore = (): State => useSyncExternalStore(subscribe, () => state);

const ev = (): PunchEvents => state.punch.events;
const withEvents = (events: PunchEvents) => set({ ...state, punch: { date: today(), events } });

export const actions = {
  clockIn: (min: number) => withEvents({ breaks: [], in: min }),
  clockOut: (min: number) => {
    const e = ev();
    // 休憩中に退勤した場合は休憩を閉じる
    withEvents({ ...e, out: min, breaks: e.breaks.map((b) => (b.end === undefined ? { ...b, end: min } : b)) });
  },
  breakStart: (min: number) => withEvents({ ...ev(), breaks: [...ev().breaks, { start: min }] }),
  breakEnd: (min: number) =>
    withEvents({ ...ev(), breaks: ev().breaks.map((b) => (b.end === undefined ? { ...b, end: min } : b)) }),
  resetToday: () => withEvents({ breaks: [] }),
  decide: (id: string, d: Decision | undefined) => {
    const decisions = { ...state.decisions };
    if (d) decisions[id] = d;
    else delete decisions[id];
    set({ ...state, decisions });
  },
};
