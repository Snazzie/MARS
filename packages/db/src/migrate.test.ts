import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { migrateDatabase } from "./migrate.ts";
import type { DatabaseClient } from "./index.ts";
import type { TransactionSql } from "postgres";
import { schemaSql } from "./schema.ts";

const migrationsUrl = new URL("./migrations/", import.meta.url);
const migration = (name: string) => readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");

test("Mars baseline materializes the canonical schema SQL", async () => {
  const baseline = await migration("0000_mars_baseline.sql");

  expect(baseline.trim()).toBe(schemaSql.trim());
  expect(baseline).toContain(
    "CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id text PRIMARY KEY, installation_id bigint NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), event_name text NOT NULL DEFAULT 'unknown', state text NOT NULL DEFAULT 'received', attempt_count integer NOT NULL DEFAULT 0, last_error text, processed_at timestamptz);",
  );
  expect(baseline).toContain(
    "CREATE INDEX IF NOT EXISTS webhook_deliveries_state_idx ON webhook_deliveries(state, received_at);",
  );
  for (const column of [
    "hit_count bigint NOT NULL DEFAULT 0 CHECK (hit_count >= 0)",
    "miss_count bigint NOT NULL DEFAULT 0 CHECK (miss_count >= 0)",
    "runner_cache_hit_count bigint NOT NULL DEFAULT 0 CHECK (runner_cache_hit_count >= 0)",
    "runner_cache_miss_count bigint NOT NULL DEFAULT 0 CHECK (runner_cache_miss_count >= 0)",
  ]) expect(baseline).toContain(column);
});

test("migration directory contains exactly one journaled baseline", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ idx: number; version: string; tag: string; when: number; breakpoints: boolean }>;
  };
  const files = (await readdir(migrationsUrl)).filter(file => file.endsWith(".sql"));

  expect(files).toEqual(["0000_mars_baseline.sql"]);
  expect(journal.entries).toEqual([
    {
      idx: 0,
      version: "7",
      when: 1700000000000,
      tag: "0000_mars_baseline",
      breakpoints: true,
    },
  ]);
});
type JournalRow = { hash: string; created_at: number };

function fakeDatabase(input: {
  applicationSchema: boolean;
  migrationTable: boolean;
  journal: JournalRow[];
}): DatabaseClient {
  const query = async <T extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ..._values: readonly unknown[]
  ) => {
    const statement = strings.join(" ");
    if (statement.includes("to_regclass")) {
      return [
        {
          application_schema: input.applicationSchema ? "users" : null,
          migration_table: input.migrationTable ? "drizzle.__drizzle_migrations" : null,
        },
      ] as unknown as T;
    }
    if (statement.includes("from drizzle.__drizzle_migrations")) return input.journal as unknown as T;
    if (statement.includes("UPDATE drizzle.__drizzle_migrations")) return [] as unknown as T;
    throw new Error(`unexpected query: ${statement}`);
  };
  return query as unknown as DatabaseClient;
}

async function baselineHash(): Promise<string> {
  const baseline = await migration("0000_mars_baseline.sql");
  return createHash("sha256").update(String(baseline)).digest("hex");
}

test("fresh database runs the baseline migration", async () => {
  const calls: string[] = [];

  await migrateDatabase(fakeDatabase({ applicationSchema: false, migrationTable: false, journal: [] }), {
    runMigrations: async () => {
      calls.push("migrate");
    },
  });

  expect(calls).toEqual(["migrate"]);
});

test("current baseline journal remains idempotent", async () => {
  const calls: string[] = [];
  const db = fakeDatabase({
    applicationSchema: true,
    migrationTable: true,
    journal: [{ hash: await baselineHash(), created_at: 1_700_000_000_000 }],
  });

  await migrateDatabase(db, {
    runMigrations: async () => {
      calls.push("migrate");
    },
  });
  await migrateDatabase(db, {
    runMigrations: async () => {
      calls.push("migrate");
    },
  });

  expect(calls).toEqual(["migrate", "migrate"]);
});

test("existing application schema without a journal is rejected", async () => {
  const calls: string[] = [];

  await expect(
    migrateDatabase(
      fakeDatabase({ applicationSchema: true, migrationTable: false, journal: [] }),
      {
        runMigrations: async () => {
          calls.push("migrate");
        },
      },
    ),
  ).rejects.toThrow(/one-baseline reset/i);

  expect(calls).toEqual([]);
});

test("an empty journal is treated as a fresh database", async () => {
  const calls: string[] = [];

  await migrateDatabase(
    fakeDatabase({ applicationSchema: false, migrationTable: true, journal: [] }),
    {
      runMigrations: async () => {
        calls.push("migrate");
      },
    },
  );

  expect(calls).toEqual(["migrate"]);
});

test("legacy journal is rejected without automatic baseline seeding", async () => {
  const calls: string[] = [];

  await expect(
    migrateDatabase(
      fakeDatabase({
        applicationSchema: true,
        migrationTable: true,
        journal: [{ hash: "legacy-hash", created_at: 1_600_000_000_000 }],
      }),
      {
        runMigrations: async () => {
          calls.push("migrate");
        },
      },
    ),
  ).rejects.toThrow(/reset|stamp/i);

  expect(calls).toEqual([]);
});
test("previous final baseline receives complete runner cache upgrade transactionally", async () => {
  const calls: string[] = [];
  let db: DatabaseClient;
  const begin = (async (callback: (tx: TransactionSql) => Promise<unknown>): Promise<unknown> => callback(db as unknown as TransactionSql)) as DatabaseClient["begin"];
  db = Object.assign(
    fakeDatabase({
      applicationSchema: true,
      migrationTable: true,
      journal: [{ hash: "24d85c25cfb2279005f02535ec5af93b65bc8d5ce543bd9963c4bea2e9cd1174", created_at: 1_700_000_000_000 }],
    }),
    { begin, unsafe: async (sql: string) => calls.push(sql) },
  ) as unknown as DatabaseClient;
  await migrateDatabase(db, { runMigrations: async () => { calls.push("migrate"); } });
  expect(calls[0]).toContain("hit_count");
  expect(calls[0]).toContain("miss_count");
  expect(calls[0]).toContain("runner_cache_hit_count");
  expect(calls[0]).toContain("runner_cache_miss_count");
  expect(calls).toContain("migrate");
});
test("failed published baseline upgrade never stamps the migration journal", async () => {
  const calls: string[] = [];
  const base = fakeDatabase({
    applicationSchema: true,
    migrationTable: true,
    journal: [{ hash: "24d85c25cfb2279005f02535ec5af93b65bc8d5ce543bd9963c4bea2e9cd1174", created_at: 1_700_000_000_000 }],
  });
  let db: DatabaseClient;
  const begin = (async (callback: (tx: TransactionSql) => Promise<unknown>): Promise<unknown> => callback(db as unknown as TransactionSql)) as DatabaseClient["begin"];
  db = Object.assign(base, {
    begin,
    unsafe: async () => { calls.push("ddl"); throw new Error("ddl failed"); },
  }) as unknown as DatabaseClient;
  await expect(migrateDatabase(db)).rejects.toThrow("ddl failed");
  expect(calls).toEqual(["ddl"]);
});
