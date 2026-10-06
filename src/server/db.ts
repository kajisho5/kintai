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

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function audit(db: Db, at: number, actor: string, action: string, detail: unknown): void {
  db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)").run(at, actor, action, JSON.stringify(detail));
}
