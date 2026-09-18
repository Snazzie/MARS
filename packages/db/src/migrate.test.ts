import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrateDatabase } from "./migrate.ts";
import type { DatabaseClient, RawDatabaseClient } from "./index.ts";

const migrationsUrl = new URL("./migrations/", import.meta.url);
const migration = (name: string) => readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");

type FakeMigrationState = {
  tableExists: boolean;
  workerColumnNullable: boolean | null;
  workerIndexExists: boolean;
  nullSnapshots: number;
  matchedSnapshots: boolean;
};

function fakeDatabase(state?: Partial<FakeMigrationState>): DatabaseClient & { queries: string[]; transactionCount: number } {
  const current: FakeMigrationState = {
    tableExists: true,
    workerColumnNullable: false,
    workerIndexExists: true,
    nullSnapshots: 0,
    matchedSnapshots: true,
    ...state,
  };
  const queries: string[] = [];
  const query = (async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    queries.push(text);
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
  }) as unknown as DatabaseClient & { queries: string[]; transactionCount: number };
  let transactionCount = 0;
  const begin = async (callback: (tx: DatabaseClient) => Promise<unknown>) => {
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
  query.queries = queries;
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
  expect(db.queries.join("\n")).toContain("ADD COLUMN IF NOT EXISTS worker_id uuid");
  expect(db.queries.join("\n")).toContain("ALTER COLUMN worker_id SET NOT NULL");
  expect(db.queries.join("\n")).toContain("CREATE INDEX IF NOT EXISTS dashboard_job_timing_worker_idx");
});

test("existing nullable timing worker column is backfilled", async () => {
  const db = fakeDatabase({ workerColumnNullable: true, workerIndexExists: false, nullSnapshots: 2 });
  await migrateDatabase(db, { runMigrations: async () => {} });
  expect(db.transactionCount).toBe(1);
  expect(db.queries.join("\n")).toContain("UPDATE dashboard_job_timing_snapshots");
});

test("unmatched timing snapshot rolls back before constraint and index creation", async () => {
  const db = fakeDatabase({ workerColumnNullable: null, workerIndexExists: false, nullSnapshots: 1, matchedSnapshots: false });
  await expect(migrateDatabase(db, { runMigrations: async () => {} })).rejects.toThrow(
    "Cannot repair dashboard_job_timing_snapshots.worker_id: 1 snapshot(s) do not match a runner lease",
  );
  expect(db.queries.join("\n")).not.toContain("ALTER COLUMN worker_id SET NOT NULL");
  expect(db.queries.join("\n")).not.toContain("CREATE INDEX IF NOT EXISTS");
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

test("generated baseline has a stable hash and required schema objects", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const sql = await migration(`${journal.entries[0]!.tag}.sql`);
  expect(createHash("sha256").update(sql).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  expect(sql).toContain('CREATE TABLE "users"');
  expect(sql).toContain('CREATE TABLE "webhook_deliveries"');
  expect(sql).toContain('"state" text DEFAULT \'received\' NOT NULL');
});

test("migration runner delegates to Drizzle with the raw client", async () => {
  const calls: RawDatabaseClient[] = [];
  const raw = fakeDatabase();
  await migrateDatabase(raw, {
    runMigrations: async received => {
      calls.push(received);
    },
  });
  expect(calls).toEqual([raw]);
});
