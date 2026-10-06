export interface Clock {
  /** 会社のタイムゾーンでの現在日時 */
  now(): { date: string; min: number; ts: number };
}

export function realClock(tz: string): Clock {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return {
    now() {
      const ts = Date.now();
      const p = Object.fromEntries(fmt.formatToParts(ts).map((x) => [x.type, x.value]));
      return {
        date: `${p.year}-${p.month}-${p.day}`,
        min: Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60,
        ts,
      };
    },
  };
}

/** テスト用: 時刻を固定・進行できる時計 */
export function fixedClock(date: string, hhmm: string): Clock & { set(date: string, hhmm: string): void } {
  let cur = { date, hhmm };
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return {
    now: () => ({ date: cur.date, min: toMin(cur.hhmm), ts: Date.parse(`${cur.date}T${cur.hhmm}:00+09:00`) }),
    set(d, t) {
      cur = { date: d, hhmm: t };
    },
  };
}
