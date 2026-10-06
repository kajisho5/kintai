import type { Interval } from "../engine";
import type { Bar } from "./types";

export function subtractIntervals(range: Interval, breaks: Interval[]): Interval[] {
  let segs = [{ ...range }];
  for (const b of breaks) {
    segs = segs.flatMap((s) => {
      if (b.end <= s.start || b.start >= s.end) return [s];
      const out: Interval[] = [];
      if (b.start > s.start) out.push({ start: s.start, end: b.start });
      if (b.end < s.end) out.push({ start: b.end, end: s.end });
      return out;
    });
  }
  return segs;
}

/** 実労働の帯。8時間を超えた部分は時間外、現在時刻より先は予定として区別する */
export function barsFor(start: number, end: number, breaks: Interval[], now: number): Bar[] {
  const bars: Bar[] = [];
  let cum = 0;
  for (const p of subtractIntervals({ start, end }, breaks)) {
    let a = p.start;
    while (a < p.end) {
      let b = cum < 480 ? Math.min(p.end, a + (480 - cum)) : p.end;
      if (a < now && b > now) b = now;
      bars.push({ from: a, to: b, ot: cum >= 480, plan: a >= now });
      cum += b - a;
      a = b;
    }
  }
  return bars;
}
