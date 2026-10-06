import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TenantManager, type TenantStatus } from "./control";
import { exportCompany } from "./export";
import { backupAll } from "./ops";

/**
 * 運用コマンド。例: npm run ops -- backup
 *   list                         会社の一覧
 *   backup [出力先] [--keep N]    全社のバックアップ（既定: data/backups、14世代）
 *   export <企業ID> <ファイル>      会社のデータをJSONに書き出す
 *   set-status <企業ID> <状態>     状態を変更（trialing|active|past_due|canceled|suspended）
 *   delete <企業ID> --yes         会社のデータを完全に削除（元に戻せません。先に backup / export を）
 *   migrate                      全社のDBを最新のスキーマにする
 */
const dataDir = process.env.DATA_DIR ?? "data";
const manager = new TenantManager(join(dataDir, "control.db"), join(dataDir, "tenants"));
const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const positional = args.filter((a) => !a.startsWith("--"));
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const tenantOf = (code?: string) => {
  const t = code ? manager.findByCode(code) : undefined;
  return t ?? fail(`企業ID「${code ?? ""}」の会社が見つかりません`);
};

switch (cmd) {
  case "list": {
    for (const t of manager.list()) {
      const n = (manager.db(t.id).prepare("SELECT COUNT(*) AS n FROM employees WHERE active = 1").get() as { n: number }).n;
      console.log([t.code, t.status, `${n}名`, `トライアル終了 ${new Date(t.trialEndsAt).toISOString().slice(0, 10)}`, t.name].join("\t"));
    }
    break;
  }
  case "backup": {
    const keepIdx = args.indexOf("--keep");
    const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : 14;
    if (!Number.isInteger(keep) || keep < 1) fail("--keep には1以上の整数を指定してください");
    const dir = positional.find((p) => p !== String(keep)) ?? join(dataDir, "backups");
    const r = backupAll(manager, dir, new Date(), keep);
    console.log(`バックアップを作成しました: ${r.dir}（${r.tenants}社）${r.pruned.length ? ` / 古い世代を${r.pruned.length}件削除` : ""}`);
    break;
  }
  case "export": {
    const t = tenantOf(positional[0]);
    const file = positional[1] ?? fail("書き出し先のファイルを指定してください");
    writeFileSync(file, JSON.stringify(exportCompany(manager.db(t.id), t, Date.now()), null, 2));
    console.log(`${t.code} のデータを ${file} に書き出しました`);
    break;
  }
  case "set-status": {
    const t = tenantOf(positional[0]);
    const status = positional[1] as TenantStatus;
    if (!["trialing", "active", "past_due", "canceled", "suspended"].includes(status)) fail("状態は trialing|active|past_due|canceled|suspended のいずれかです");
    manager.update(t.id, { status });
    console.log(`${t.code}: ${t.status} → ${status}`);
    break;
  }
  case "delete": {
    const t = tenantOf(positional[0]);
    if (!flag("yes")) fail(`${t.code}（${t.name}）のデータを完全に削除します。元に戻せません。実行するには --yes を付けてください`);
    manager.purge(t.id);
    console.log(`${t.code} のデータを削除しました`);
    break;
  }
  case "migrate": {
    for (const t of manager.list()) {
      const v = manager.db(t.id).prepare("SELECT MAX(id) AS v FROM schema_migrations").get() as { v: number };
      console.log(`${t.code}: スキーマ v${v.v}`);
    }
    break;
  }
  default:
    fail("使い方: npm run ops -- <list|backup|export|set-status|delete|migrate>（詳細は src/server/cli.ts の先頭を参照）");
}
manager.close();
