import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import type { DatabaseClient, RawDatabaseClient } from "./index.ts";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const baselineFile = new URL("./migrations/0000_colossal_storm.sql", import.meta.url);
const journalFile = new URL("./migrations/meta/_journal.json", import.meta.url);
const requiredTables = [
  "audit_events", "commands", "control_plane_config", "dashboard_installations", "dashboard_job_resource_samples",
  "dashboard_job_steps", "dashboard_job_timing_snapshots", "dashboard_jobs", "dashboard_log_chunks", "dashboard_mutations",
  "dashboard_outbox_invalidations", "dashboard_repositories", "dashboard_resource_observations", "dashboard_run_stages",
  "dashboard_runs", "dashboard_step_log_chunks", "github_app_config", "github_discovery_checkpoints", "github_setup_states",
  "job_claims", "memberships", "organizations", "runner_leases", "runner_pools", "sessions", "system_onboarding", "users",
  "webhook_deliveries", "worker_bootstrap_credentials", "worker_cache_entries", "worker_cache_snapshot_entries",
  "worker_cache_status", "worker_mutations", "workers",
] as const;

type MigrationJournalRow = { hash: string | null; created_at: number | string | null };
type MigrationState = { applicationSchema: boolean; journal: MigrationJournalRow[] };
type MigrationJournal = { entries: Array<{ when: number }> };

export type MigrationRunner = (sql: RawDatabaseClient) => Promise<void>;
export type MigrateDatabaseOptions = { runMigrations?: MigrationRunner };

async function readMigrationState(sql: RawDatabaseClient): Promise<MigrationState> {
  const [objects] = await sql<{ application_schema: string | null; migration_table: string | null }[]>`
    select to_regclass('public.users') as application_schema, to_regclass('drizzle.__drizzle_migrations') as migration_table`;
  const journal = objects?.migration_table
    ? await sql<MigrationJournalRow[]>`select hash, created_at from drizzle.__drizzle_migrations order by id`
    : [];
  return { applicationSchema: Boolean(objects?.application_schema), journal };
}

async function stampExistingSchema(sql: RawDatabaseClient): Promise<boolean> {
  const state = await readMigrationState(sql);
  if (!state.applicationSchema || state.journal.length > 0) return false;
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count
    from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${requiredTables})`;
  if (count !== requiredTables.length) {
    throw new Error(`Existing database schema is incomplete (${count}/${requiredTables.length} required tables); refusing to stamp the Drizzle baseline.`);
  }
  const baseline = await Bun.file(baselineFile).text();
  const journal = JSON.parse(await readFile(journalFile, "utf8")) as MigrationJournal;
  const entry = journal.entries[0];
  if (!entry) throw new Error("Generated Drizzle migration journal has no baseline entry");
  const hash = createHash("sha256").update(baseline).digest("hex");
  if (!sql.begin) throw new Error("Existing-schema migration requires a database transaction");
  await sql.begin(async tx => {
    await tx.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
    await tx.unsafe("CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)");
    await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${entry.when})`;
  });
  return true;
}

const defaultMigrationRunner: MigrationRunner = async sql => {
  await drizzleMigrate(drizzle(sql), { migrationsFolder });
};

export async function migrateDatabase(db: DatabaseClient, options: MigrateDatabaseOptions = {}): Promise<void> {
  const raw = db.$client ?? db;
  if (!options.runMigrations) await stampExistingSchema(raw);
  await (options.runMigrations ?? defaultMigrationRunner)(raw);
}
