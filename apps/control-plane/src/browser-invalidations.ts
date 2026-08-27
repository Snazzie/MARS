import type { DatabaseClient } from "@mars/db";

export type BrowserInvalidation = { organizationId: string; sequence: number; keys: string[]; occurredAt: string };

export async function canSubscribeToOrganization(db: DatabaseClient, user: { id: string; isGlobalAdmin: boolean }, organizationId: string): Promise<boolean> {
  if (user.isGlobalAdmin) return true;
  const [membership] = await db`SELECT 1 FROM memberships WHERE user_id=${user.id} AND organization_id=${organizationId}`;
  return Boolean(membership);
}

export async function loadBrowserInvalidations(db: DatabaseClient, organizationId: string, cursor: number, limit = 100): Promise<BrowserInvalidation[]> {
  const safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await db<Array<{ organizationId: string; sequence: number | string; keys: unknown; occurredAt: Date | string }>>`
    SELECT organization_id AS "organizationId",sequence,keys,occurred_at AS "occurredAt"
    FROM dashboard_outbox_invalidations
    WHERE organization_id=${organizationId} AND sequence>${safeCursor}
    ORDER BY sequence ASC LIMIT ${safeLimit}`;
  return rows.map((row) => {
    let keys = row.keys;
    if (typeof keys === "string") {
      try { keys = JSON.parse(keys); } catch { keys = []; }
    }
    return {
      organizationId: String(row.organizationId),
      sequence: Number(row.sequence),
      keys: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
    };
  }).filter((row) => Number.isSafeInteger(row.sequence) && row.sequence > safeCursor);
}
