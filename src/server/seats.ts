import type { BillingGateway } from "./billing";
import { activeCount } from "./context";
import type { TenantManager } from "./control";
import type { Db } from "./db";

/**
 * 在籍人数を Stripe の課金数量に反映する。失敗しても社員の登録・退職は止めず、
 * 「未反映」の印を付けて、定期ジョブで再試行する（人数課金のずれを残さないため）。
 */
export async function syncSeats(manager: TenantManager, billing: BillingGateway, tenantId: string, db: Db): Promise<void> {
  const tenant = manager.findById(tenantId);
  if (!billing.configured || !tenant?.stripeItemId || tenant.status === "canceled") return;
  try {
    await billing.updateSeats({ itemId: tenant.stripeItemId, quantity: activeCount(db) });
    if (tenant.seatsDirty) manager.update(tenant.id, { seatsDirty: false });
  } catch (e) {
    manager.update(tenant.id, { seatsDirty: true });
    console.error(`座席数の反映に失敗しました（${tenant.code}）。後で再試行します:`, e instanceof Error ? e.message : e);
  }
}
