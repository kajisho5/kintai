/** RFC 4180 に沿った最小の CSV パーサ（引用符・引用符内の改行・BOM・CRLF に対応） */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * 取り込む前の、おおまかな確認（解析は同期処理で重いため、行数・列数が多すぎる入力を、解析の前に断る）。
 * 改行の数と、カンマ・タブの数だけを数える。問題があれば、利用者向けのメッセージ。
 */
export function csvTooBig(text: string, maxRows: number, maxCols = 60): string | undefined {
  let lines = 1;
  let separators = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) lines++;
    else if (ch === 44 || ch === 9) separators++;
  }
  if (lines - 1 > maxRows + 10) return `一度に取り込めるのは${maxRows}行までです`;
  if (separators > (maxRows + 10) * maxCols) return "列が多すぎます。テンプレートの形式で作成してください";
  return undefined;
}
