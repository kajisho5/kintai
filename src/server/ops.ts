import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TenantManager } from "./control";

export interface BackupResult {
  dir: string;
  tenants: number;
  pruned: string[];
}

/**
 * 全社のデータベースと管理用DBのバックアップを dir/YYYYMMDD-HHMMSS/ に作る。
 * VACUUM INTO は、稼働中でも一貫したスナップショットを取れる（ファイルを直接コピーすると壊れうる）。
 */
export function backupAll(manager: TenantManager, rootDir: string, now: Date, keep = 14): BackupResult {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(rootDir, stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  manager.backupControl(join(dir, "control.db"));
  const tenants = manager.list();
  for (const t of tenants) {
    manager.db(t.id).exec(`VACUUM INTO '${join(dir, `${t.id}.db`).replace(/'/g, "''")}'`);
  }
  // 古い世代を削除する（keep 世代を残す）
  const gens = readdirSync(rootDir)
    .filter((n) => /^\d{8}-\d{6}$/.test(n) && statSync(join(rootDir, n)).isDirectory())
    .sort();
  const pruned = gens.slice(0, Math.max(0, gens.length - keep));
  for (const g of pruned) rmSync(join(rootDir, g), { recursive: true, force: true });
  return { dir, tenants: tenants.length, pruned };
}
