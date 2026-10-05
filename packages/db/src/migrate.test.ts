import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { migrateDatabase } from "./migrate.ts";
import type { RawDatabaseClient } from "./index.ts";

const migrationsUrl = new URL("./migrations/", import.meta.url);

type FakeMigrationState = {
  tableExists: boolean;
  workerColumnNullable: boolean | null;
  workerIndexExists: boolean;
  nullSnapshots: number;
  matchedSnapshots: boolean;
};

function fakeDatabase(state?: Partial<FakeMigrationState>): RawDatabaseClient & { state: FakeMigrationState; transactionCount: number } {
  const current: FakeMigrationState = {
    tableExists: true,
    workerColumnNullable: false,
    workerIndexExists: true,
    nullSnapshots: 0,
    matchedSnapshots: true,
    ...state,
  };
  const query = (async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    if (text.includes("information_schema.tables")) return [{ tableExists: current.tableExists }];
    if (text.includes("information_schema.columns")) {
      return current.workerColumnNullable === null
        ? []
        : [{ columnName: "worker_id", isNullable: current.workerColumnNullable ? "YES" : "NO" }];
    }
    if (text.includes("FROM pg_indexes")) return current.workerIndexExists ? [{ indexName: "dashboard_job_timing_worker_idx" }] : [];
    if (text.includes("SELECT count(*)")) return [{ remaining: current.nullSnapshots }];
    if (text.includes("UPDATE dashboard_job_timing_snapshots")) {
      if (current.matchedSnapshots) current.nullSnapshots = 0;
      return [];
    }
    if (text.includes("CREATE INDEX")) {
      current.workerIndexExists = true;
      return [];
    }
    if (text.includes("ALTER COLUMN worker_id SET NOT NULL")) {
      current.workerColumnNullable = false;
      return [];
    }
    if (text.includes("ADD COLUMN")) {
      current.workerColumnNullable = true;
      return [];
    }
    return [];
  }) as unknown as RawDatabaseClient & { state: FakeMigrationState; transactionCount: number };
  let transactionCount = 0;
  const begin = async (callback: (tx: RawDatabaseClient) => Promise<unknown>) => {
    transactionCount += 1;
    const snapshot = { ...current };
    try {
      return await callback(query);
    } catch (error) {
      Object.assign(current, snapshot);
      throw error;
    }
  };
  Object.defineProperty(query, "begin", { value: begin });
  query.state = current;
  Object.defineProperty(query, "transactionCount", { get: () => transactionCount });
  return query;
}

test("healthy timing schema performs no repair transaction", async () => {
  const db = fakeDatabase();
  await migrateDatabase(db, { runMigrations: async () => {} });
  expect(db.transactionCount).toBe(0);
});

test("missing timing worker column is backfilled and constrained", async () => {
  const db = fakeDatabase({ workerColumnNullable: null, workerIndexExists: false, nullSnapshots: 3 });
  await migrateDatabase(db, { runMigrations: async () => {} });
  expect(db.transactionCount).toBe(1);
  expect(db.state.workerColumnNullable).toBe(false);
  expect(db.state.nullSnapshots).toBe(0);
  expect(db.state.workerIndexExists).toBe(true);
});

test("existing nullable timing worker column is backfilled", async () => {
  const db = fakeDatabase({ workerColumnNullable: true, workerIndexExists: false, nullSnapshots: 2 });
  await migrateDatabase(db, { runMigrations: async () => {} });
  expect(db.transactionCount).toBe(1);
  expect(db.state.workerColumnNullable).toBe(false);
  expect(db.state.nullSnapshots).toBe(0);
});

test("unmatched timing snapshot rolls back before constraint and index creation", async () => {
  const db = fakeDatabase({ workerColumnNullable: null, workerIndexExists: false, nullSnapshots: 1, matchedSnapshots: false });
  await expect(migrateDatabase(db, { runMigrations: async () => {} })).rejects.toThrow(
    "Cannot repair dashboard_job_timing_snapshots.worker_id: 1 snapshot(s) do not match a runner lease",
  );
  expect(db.state.workerColumnNullable).toBeNull();
  expect(db.state.nullSnapshots).toBe(1);
  expect(db.state.workerIndexExists).toBe(false);
});

test("migration directory contains only Drizzle-generated SQL and metadata", async () => {
  const files = (await readdir(migrationsUrl)).sort();
  const sqlFiles = files.filter(file => file.endsWith(".sql"));
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    dialect: string;
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  expect(sqlFiles).toHaveLength(journal.entries.length);
  expect(sqlFiles).toEqual(journal.entries.map(entry => `${entry.tag}.sql`));
  expect(journal.dialect).toBe("postgresql");
});

