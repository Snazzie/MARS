import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { integer, pgSchema } from "drizzle-orm/pg-core";
import { createDb, defineQueries, listJobResourceTrends, type DatabaseClient } from "./index.ts";

const databaseUrl = Bun.env.MARS_E2E_DATABASE_URL;
const namespace = `prepared_${randomUUID().replaceAll("-", "")}`;
const counters = pgSchema(namespace).table("counters", { id: integer().primaryKey(), value: integer().notNull() });
const queries = defineQueries(db => ({
  read: db.select({ value: counters.value }).from(counters).where(eq(counters.id, sql.placeholder("id"))).prepare("prepared_regression_read"),
  write: db.update(counters).set({ value: sql`${sql.placeholder("value")}::integer` }).where(eq(counters.id, sql.placeholder("id"))).prepare("prepared_regression_write"),
}));
let db: DatabaseClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  db = createDb(databaseUrl);
  // Test-owned schema DDL and fixture seeds deliberately use the administrative raw client.
  await db.$client.unsafe(`CREATE SCHEMA "${namespace}"`);
  await db.$client.unsafe(`CREATE TABLE "${namespace}".counters (id integer PRIMARY KEY, value integer NOT NULL)`);
  await db.$client.unsafe(`INSERT INTO "${namespace}".counters VALUES (1,0),(2,0),(3,0),(4,0)`);
});

afterAll(async () => {
  if (!db) return;
  try { await db.$client.unsafe(`DROP SCHEMA "${namespace}" CASCADE`); }
  finally { await db.$client.end({ timeout: 1 }); }
});

const integration = databaseUrl ? test : test.skip;

integration("startup-prepared queries retain transaction read-your-writes and rollback", async () => {
  await expect(db.transaction(async tx => {
    await queries(tx).write.execute({ id: 1, value: 7 });
    expect(await queries(tx).read.execute({ id: 1 })).toEqual([{ value: 7 }]);
    throw new Error("rollback probe");
  })).rejects.toThrow("rollback probe");
  expect(await queries(db).read.execute({ id: 1 })).toEqual([{ value: 0 }]);
});

integration("concurrent transactions never share prepared-query connections", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let arrivals = 0;
  async function waitForBoth() { if (++arrivals === 2) release(); await barrier; }
  const outcomes = await Promise.allSettled([
    db.transaction(async tx => {
      await queries(tx).write.execute({ id: 2, value: 22 });
      await waitForBoth();
      expect(await queries(tx).read.execute({ id: 2 })).toEqual([{ value: 22 }]);
      expect(await queries(tx).read.execute({ id: 3 })).toEqual([{ value: 0 }]);
    }),
    db.transaction(async tx => {
      await queries(tx).write.execute({ id: 3, value: 33 });
      await waitForBoth();
      expect(await queries(tx).read.execute({ id: 3 })).toEqual([{ value: 33 }]);
      expect(await queries(tx).read.execute({ id: 2 })).toEqual([{ value: 0 }]);
      throw new Error("isolated rollback");
    }),
  ]);
  expect(outcomes[0].status).toBe("fulfilled");
  expect(outcomes[1].status).toBe("rejected");
  expect(await queries(db).read.execute({ id: 2 })).toEqual([{ value: 22 }]);
  expect(await queries(db).read.execute({ id: 3 })).toEqual([{ value: 0 }]);
}, 15_000);

integration("nested savepoint rollback preserves the outer prepared transaction", async () => {
  await db.transaction(async tx => {
    await queries(tx).write.execute({ id: 4, value: 4 });
    await expect(tx.transaction(async nested => {
      await queries(nested).write.execute({ id: 4, value: 44 });
      nested.rollback();
    })).rejects.toThrow();
    expect(await queries(tx).read.execute({ id: 4 })).toEqual([{ value: 4 }]);
  });
  expect(await queries(db).read.execute({ id: 4 })).toEqual([{ value: 4 }]);
});

integration("all-organization resource trends exclude data without membership", async () => {
  const result = await listJobResourceTrends(db, "all", {
    from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z",
  }, randomUUID());
  expect(result.summary.jobCount).toBe(0);
  expect(result.summary.completedRunCount).toBe(0);
  expect(result.jobs).toEqual([]);
  expect(result.selectedJob).toBeNull();
});
