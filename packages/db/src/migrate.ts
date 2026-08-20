import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import type { DatabaseClient } from "./index.ts";
import { baselineSchemaSql, jobTimingMigrationSql, jsonShapeNormalizationMigrationSql, onboardingVerificationMigrationSql, resourceTelemetryMigrationSql, workerConfigurationMigrationSql, workerJsonNormalizationMigrationSql, workerTelemetryMigrationSql } from "./schema.ts";

type LegacyMigration = { version: number; name: string; sql: string };

const legacyChecksums = new Map<number, Set<string>>([
  [1, new Set(["fed95e0e171ee0e4a8f708fcc48e2f5a1e241f0d54d6a83c02fed0e7bd0f0a75"])],
  [8, new Set(["c09d8da50704baf298b3dfc4413c85b01a08ed9dab05e72e863085927da84bff"])],
]);

const legacyMigrations: LegacyMigration[] = [
  { version: 1, name: "baseline", sql: baselineSchemaSql },
  {
    version: 2,
    name: "webhook-inbox-state",
    sql: `ALTER TABLE webhook_deliveries
      ADD COLUMN IF NOT EXISTS event_name text NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'received',
      ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_error text,
      ADD COLUMN IF NOT EXISTS processed_at timestamptz;
      CREATE INDEX IF NOT EXISTS webhook_deliveries_state_idx ON webhook_deliveries(state, received_at);`,
  },
  { version: 3, name: "worker-configuration-state", sql: workerConfigurationMigrationSql },
  { version: 4, name: "worker-json-normalization", sql: workerJsonNormalizationMigrationSql },
  { version: 5, name: "json-shape-normalization", sql: jsonShapeNormalizationMigrationSql },
  { version: 6, name: "onboarding-verification", sql: onboardingVerificationMigrationSql },
  { version: 7, name: "worker-telemetry-timestamps", sql: workerTelemetryMigrationSql },
  { version: 8, name: "job-timing-snapshots", sql: jobTimingMigrationSql },
  { version: 9, name: "job-resource-telemetry", sql: resourceTelemetryMigrationSql },
];

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const baselineCreatedAt = 1_700_000_000_000;
const migrationHash = (sql: string) => createHash("sha256").update(sql).digest("hex");

async function hasLegacyHistory(sql: DatabaseClient): Promise<boolean> {
  const [row] = await sql<{ name: string | null }[]>`select to_regclass('public.schema_migrations') as name`;
  return Boolean(row?.name);
}

async function applyLegacyMigrations(sql: DatabaseClient): Promise<void> {
  await sql.begin(async tx => {
    await tx`create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`;
    for (const migration of legacyMigrations) {
      const checksum = migrationHash(migration.sql);
      const [applied] = await tx<{ checksum: string }[]>`select checksum from schema_migrations where version=${migration.version}`;
      if (applied) {
        if (applied.checksum !== checksum && !legacyChecksums.get(migration.version)?.has(applied.checksum)) throw new Error(`migration_checksum_mismatch:${migration.version}`);
        continue;
      }
      for (const statement of migration.sql.split(";").map(statement => statement.trim()).filter(Boolean)) await tx.unsafe(statement);
      await tx`insert into schema_migrations(version,name,checksum) values (${migration.version},${migration.name},${checksum})`;
    }
  });
}

async function seedLegacyHistory(sql: DatabaseClient): Promise<void> {
  await sql.begin(async tx => {
    await tx`create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`;
    for (const migration of legacyMigrations) {
      await tx`insert into schema_migrations(version,name,checksum) values (${migration.version},${migration.name},${migrationHash(migration.sql)}) on conflict (version) do nothing`;
    }
  });
}

async function seedDrizzleBaseline(sql: DatabaseClient): Promise<void> {
  await sql`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    );
  `;
  await sql`
    insert into drizzle.__drizzle_migrations(hash, created_at)
    select ${migrationHash(await Bun.file(new URL("./migrations/0000_legacy_baseline.sql", import.meta.url)).text())}, ${baselineCreatedAt}
    where not exists (select 1 from drizzle.__drizzle_migrations where created_at=${baselineCreatedAt});
  `;
}

async function runDrizzleMigrations(sql: DatabaseClient): Promise<void> {
  const db = drizzle(sql);
  await drizzleMigrate(db, { migrationsFolder });
}

export async function migrateDatabase(sql: DatabaseClient): Promise<void> {
  const connection = await sql.reserve();
  try {
    await connection`select pg_advisory_lock(hashtext('whitesmith:migrations'))`;
    if (await hasLegacyHistory(connection)) {
      await applyLegacyMigrations(connection);
      await seedDrizzleBaseline(connection);
      await runDrizzleMigrations(connection);
      return;
    }
    await runDrizzleMigrations(connection);
    await seedLegacyHistory(connection);
  } finally {
    await connection`select pg_advisory_unlock(hashtext('whitesmith:migrations'))`;
    connection.release();
  }
}
