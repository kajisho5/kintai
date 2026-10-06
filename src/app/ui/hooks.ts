import { useEffect, useState } from "react";
import { minutesOfDay } from "../format";

/** 現在時刻（分、小数あり）。1秒ごとに更新 */
export function useNow(intervalMs = 1000): { date: Date; min: number } {
  const [date, setDate] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setDate(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return { date, min: minutesOfDay(date) };
}

export function useHashRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, "") || "dashboard";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (to) => (window.location.hash = `/${to}`)];
}
