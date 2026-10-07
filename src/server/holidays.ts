import { HOLIDAYS_JP, HOLIDAYS_JP_LAST_YEAR } from "../domain/holidays-jp";
import type { Db } from "./db";
import { tx } from "./db";
import { getSetting } from "./repo";

/**
 * 国民の祝日をテナント DB に取り込む。取り込み済みの年は触らないので、
 * 管理者が削除した祝日（その会社は出勤する日など）は復活しない。新しい年のデータが増えたときだけ追加される。
 */
export function syncNationalHolidays(db: Db): void {
  const done = Number(getSetting(db, "holidays_synced_year", "0"));
  if (done >= HOLIDAYS_JP_LAST_YEAR) return;
  tx(db, () => {
    const ins = db.prepare("INSERT OR IGNORE INTO holidays (date, name, kind) VALUES (?, ?, 'national')");
    for (const [date, name] of HOLIDAYS_JP) if (Number(date.slice(0, 4)) > done) ins.run(date, name);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('holidays_synced_year', ?)").run(String(HOLIDAYS_JP_LAST_YEAR));
  });
}
