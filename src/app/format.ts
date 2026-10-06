export const WD = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 分 → "H:MM"（時間量の表示） */
export const dur = (m: number): string => {
  const r = Math.round(m);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
};

/** 0 のときは "–" */
export const durOrDash = (m: number): string => (m <= 0 ? "–" : dur(m));

/** 分 → "HH:MM"（時刻の表示。24:00 以降は翌日扱いで 24+ 表記） */
export const clock = (m: number): string => {
  const r = Math.round(m);
  return `${String(Math.floor(r / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`;
};

export const hours1 = (m: number): string => (m / 60).toFixed(1);

export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;

export const dowOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

export const jpDate = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  return `${y}年${m}月${d}日（${WD[dowOf(date)]}）`;
};

export const shortDate = (date: string): string => {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
};

export const ymLabel = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  return `${y}年${m}月`;
};

/**
 * CSV の1セル分。カンマ・引用符・改行は引用符で囲む。
 * 先頭が = + - @ やタブ・改行の文字列は、Excel で数式として実行されないよう ' を付ける
 * （氏名などに悪意のある値が入っていても、開いた人のPCで動かないようにする）。
 */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel で文字化けしないよう BOM を付けた CSV 文字列 */
export const buildCsv = (rows: (string | number)[][]): string => "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

export function csvDownload(filename: string, rows: (string | number)[][]): void {
  const url = URL.createObjectURL(new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐに解放するとブラウザによってはファイル名が失われるため、少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
