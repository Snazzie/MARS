import { and, eq, gt, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";

export type BrowserInvalidation = { organizationId: string; sequence: number; keys: string[]; occurredAt: string };
const queries = defineQueries((db) => ({
  membership: db.select({ allowed: sql`1` }).from(schema.memberships).where(and(eq(schema.memberships.userId, sql.placeholder("userId")), eq(schema.memberships.organizationId, sql.placeholder("organizationId")))).prepare("browser_invalidation_membership"),
  invalidations: db.select({ organizationId: schema.dashboardOutboxInvalidations.organizationId, sequence: schema.dashboardOutboxInvalidations.sequence, keys: schema.dashboardOutboxInvalidations.keys, occurredAt: schema.dashboardOutboxInvalidations.occurredAt }).from(schema.dashboardOutboxInvalidations)
    .where(and(eq(schema.dashboardOutboxInvalidations.organizationId, sql.placeholder("organizationId")), gt(schema.dashboardOutboxInvalidations.sequence, sql.placeholder("cursor"))))
    .orderBy(schema.dashboardOutboxInvalidations.sequence).limit(sql.placeholder("limit")).prepare("browser_invalidation_replay"),
}));
export async function canSubscribeToOrganization(db: DatabaseClient, user: { id: string; isGlobalAdmin: boolean }, organizationId: string): Promise<boolean> {
  if (user.isGlobalAdmin) return true;
  const [membership] = await queries(db).membership.execute({ userId: user.id, organizationId });
  return Boolean(membership);
}
export async function loadBrowserInvalidations(db: DatabaseClient, organizationId: string, cursor: number, limit = 100): Promise<BrowserInvalidation[]> {
  const safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await queries(db).invalidations.execute({ organizationId, cursor: safeCursor, limit: safeLimit });
  return rows.map((row) => {
    let keys = row.keys;
    if (typeof keys === "string") {
      try { keys = JSON.parse(keys); } catch { keys = []; }
    }
    return {
      organizationId: String(row.organizationId),
      sequence: Number(row.sequence),
      keys: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
      occurredAt: new Date(row.occurredAt).toISOString(),
    };
  }).filter((row) => Number.isSafeInteger(row.sequence) && row.sequence > safeCursor);
}