// 内閣府の「国民の祝日」CSV から src/domain/holidays-jp.ts を生成する。
//   node scripts/update-holidays.mjs                      # 公式URLから取得
//   node scripts/update-holidays.mjs path/to/syukujitsu.csv   # ローカルのCSV（Shift_JIS）を使う
// 毎年2月ごろに翌年分が公表されるため、年1回実行してコミットすること。
import { readFileSync, writeFileSync } from "node:fs";

const URL_ = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";
const FROM_YEAR = 2024;

const arg = process.argv[2];
const buf = arg ? readFileSync(arg) : Buffer.from(await (await fetch(URL_)).arrayBuffer());
const text = new TextDecoder("shift_jis").decode(buf);

const rows = text
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split(","))
  .filter((c) => c.length >= 2 && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(c[0]))
  .map(([d, n]) => {
    const [y, m, day] = d.split("/").map(Number);
    return { y, date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, name: n.trim() };
  })
  .filter((r) => r.y >= FROM_YEAR);

if (rows.length < 30) throw new Error(`祝日の件数が少なすぎます（${rows.length}件）。CSVの形式が変わった可能性があります`);
const last = Math.max(...rows.map((r) => r.y));
const body = rows.map((r) => `  ["${r.date}", "${r.name}"],`).join("\n");

writeFileSync(
  new URL("../src/domain/holidays-jp.ts", import.meta.url),
  `// 自動生成: scripts/update-holidays.mjs（出典: 内閣府「国民の祝日について」 ${URL_}）
// 手で編集しないこと。年1回、翌年分が公表されたら再生成する。
export const HOLIDAYS_JP: readonly (readonly [date: string, name: string])[] = [
${body}
];

/** データが含む最後の年。これを過ぎたら祝日の更新が必要 */
export const HOLIDAYS_JP_LAST_YEAR = ${last};
`,
);
console.log(`${rows.length}件（${FROM_YEAR}〜${last}年）を書き出しました`);
