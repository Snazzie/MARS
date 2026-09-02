import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { migrateDatabase } from "./migrate.ts";
import type { RawDatabaseClient } from "./index.ts";
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
});

test("migration directory contains exactly one journaled baseline", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url))) as {
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
}): RawDatabaseClient {
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
  return query as unknown as RawDatabaseClient;
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
test("previous final baseline receives runner cache upgrade in place", async () => {
  const calls: string[] = [];
  const db = Object.assign(
    fakeDatabase({
      applicationSchema: true,
      migrationTable: true,
      journal: [{ hash: "24d85c25cfb2279005f02535ec5af93b65bc8d5ce543bd9963c4bea2e9cd1174", created_at: 1_700_000_000_000 }],
    }),
    { unsafe: async (sql: string) => calls.push(sql) },
  );
  await migrateDatabase(db, { runMigrations: async () => calls.push("migrate") });
  expect(calls[0]).toContain("runner_cache_enabled");
  expect(calls).toContain("migrate");
});
