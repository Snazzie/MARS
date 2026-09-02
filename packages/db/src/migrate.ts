import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import type { DatabaseClient, RawDatabaseClient } from "./index.ts";
import { workerRunnerCacheUpgradeSql } from "./schema.ts";
const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const baselineCreatedAt = 1_700_000_000_000;
const previousBaselineHash = "24d85c25cfb2279005f02535ec5af93b65bc8d5ce543bd9963c4bea2e9cd1174";
const migrationHash = (sql: string) => createHash("sha256").update(sql).digest("hex");

type MigrationJournalRow = {
  hash: string | null;
  created_at: number | string | null;
};

type MigrationState = {
  applicationSchema: boolean;
  journal: MigrationJournalRow[];
};

export type MigrationRunner = (sql: RawDatabaseClient) => Promise<void>;
export type MigrateDatabaseOptions = {
  runMigrations?: MigrationRunner;
};

async function readMigrationState(sql: RawDatabaseClient): Promise<MigrationState> {
  const [objects] = await sql<
    { application_schema: string | null; migration_table: string | null }[]
  >`select to_regclass('public.users') as application_schema, to_regclass('drizzle.__drizzle_migrations') as migration_table`;
  const journal = objects?.migration_table
    ? await sql<MigrationJournalRow[]>`select hash, created_at from drizzle.__drizzle_migrations order by id`
    : [];

  return {
    applicationSchema: Boolean(objects?.application_schema),
    journal,
  };
}

function isFinalBaseline(journal: MigrationJournalRow[], baselineHash: string): boolean {
  const [entry] = journal;
  return (
    journal.length === 1 &&
    entry?.hash === baselineHash &&
    Number(entry.created_at) === baselineCreatedAt
  );
}

function isRunnerCacheUpgradeBaseline(journal: MigrationJournalRow[]): boolean {
  const [entry] = journal;
  return journal.length === 1 && entry?.hash === previousBaselineHash && Number(entry.created_at) === baselineCreatedAt;
}
function invalidMigrationStateError(): Error {
  return new Error(
    "Database has an existing application schema or non-final Drizzle migration journal. This database requires a one-baseline reset: reset the database or explicitly stamp the one baseline migration (0000_mars_baseline) before retrying; automatic conversion is disabled.",
  );
}

const defaultMigrationRunner: MigrationRunner = async sql => {
  await drizzleMigrate(drizzle(sql), { migrationsFolder });
};

export async function migrateDatabase(
  db: DatabaseClient,
  options: MigrateDatabaseOptions = {},
): Promise<void> {
  const raw = db.$client ?? db;
  const state = await readMigrationState(raw);
  const baselineHash = migrationHash(
    await Bun.file(new URL("./migrations/0000_mars_baseline.sql", import.meta.url)).text(),
  );
  const finalBaseline = isFinalBaseline(state.journal, baselineHash);
  const runnerCacheUpgradeBaseline = isRunnerCacheUpgradeBaseline(state.journal);
  if (runnerCacheUpgradeBaseline) {
    await raw.unsafe(workerRunnerCacheUpgradeSql);
    await raw`UPDATE drizzle.__drizzle_migrations SET hash=${baselineHash} WHERE hash=${previousBaselineHash} AND created_at=${baselineCreatedAt}`;
  }
  if ((!finalBaseline && !runnerCacheUpgradeBaseline && state.applicationSchema) || (state.journal.length > 0 && !finalBaseline && !runnerCacheUpgradeBaseline)) {
    throw invalidMigrationStateError();
  }
  await (options.runMigrations ?? defaultMigrationRunner)(raw);
}
