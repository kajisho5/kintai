import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations";

export type Db = DatabaseSync;

/** テナント DB を開き、未適用のマイグレーションを適用する */
export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/** ロールバックの回数（DBごと）。total_changes() はロールバックしても戻らないので、書き込みの取り消しを、集計の使い回しの判定に使う */
const rollbacks = new WeakMap<Db, number>();
export const rollbackCount = (db: Db): number => rollbacks.get(db) ?? 0;

const changesOf = (db: Db): number => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  const before = changesOf(db);
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    // 書き込みがあったときだけ数える（入力の誤りで何も書かずに終わった tx では、集計の使い回しを捨てない）
    if (changesOf(db) !== before) rollbacks.set(db, rollbackCount(db) + 1);
    db.exec("ROLLBACK");
    throw e;
  }
}

export function audit(db: Db, at: number, actor: string, action: string, detail: unknown): void {
  db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)").run(at, actor, action, JSON.stringify(detail));
}
