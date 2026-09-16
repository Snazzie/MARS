import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import type { DatabaseClient, RawDatabaseClient } from "./index.ts";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export type MigrationRunner = (sql: RawDatabaseClient) => Promise<void>;
export type MigrateDatabaseOptions = { runMigrations?: MigrationRunner };

const defaultMigrationRunner: MigrationRunner = async sql => {
  await drizzleMigrate(drizzle(sql), { migrationsFolder });
};

export async function migrateDatabase(db: DatabaseClient, options: MigrateDatabaseOptions = {}): Promise<void> {
  const raw = db.$client ?? db;
  await (options.runMigrations ?? defaultMigrationRunner)(raw);

  const [{ tableExists }] = await db<{ tableExists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'dashboard_job_timing_snapshots'
    ) AS "tableExists"
  `;
  if (!tableExists) return;

  const columns = await db<{ columnName: string; isNullable: string }[]>`
    SELECT column_name AS "columnName", is_nullable AS "isNullable"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dashboard_job_timing_snapshots'
      AND column_name = 'worker_id'
  `;
  const indexes = await db<{ indexName: string }[]>`
    SELECT indexname AS "indexName"
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'dashboard_job_timing_snapshots'
      AND indexname = 'dashboard_job_timing_worker_idx'
  `;
  if (columns[0]?.isNullable === "NO" && indexes.length > 0) return;

  await db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('mars:migrate:job-timing-worker'))`;
    await tx`ALTER TABLE dashboard_job_timing_snapshots ADD COLUMN IF NOT EXISTS worker_id uuid`;
    await tx`
      UPDATE dashboard_job_timing_snapshots AS snapshots
      SET worker_id = leases.worker_id
      FROM runner_leases AS leases
      WHERE snapshots.worker_id IS NULL
        AND snapshots.organization_id = leases.organization_id
        AND snapshots.github_job_id = leases.github_job_id
    `;
    const [{ remaining }] = await tx<{ remaining: number | string }[]>`
      SELECT count(*) AS remaining
      FROM dashboard_job_timing_snapshots
      WHERE worker_id IS NULL
    `;
    const count = Number(remaining);
    if (count > 0) {
      throw new Error(
        `Cannot repair dashboard_job_timing_snapshots.worker_id: ${count} snapshot(s) do not match a runner lease`,
      );
    }
    await tx`ALTER TABLE dashboard_job_timing_snapshots ALTER COLUMN worker_id SET NOT NULL`;
    await tx`
      CREATE INDEX IF NOT EXISTS dashboard_job_timing_worker_idx
      ON dashboard_job_timing_snapshots (organization_id, worker_id, completed_at DESC)
    `;
  });
}
