import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import type { DatabaseClient, RawDatabaseClient } from "./index.ts";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const baselineCreatedAt = 1_700_000_000_000;
const migrationHash = (sql: string) => createHash("sha256").update(sql).digest("hex");

async function hasApplicationSchema(sql: RawDatabaseClient): Promise<boolean> {
  const [row] = await sql<{ name: string | null }[]>`select to_regclass('public.users') as name`;
  return Boolean(row?.name);
}

async function seedDrizzleBaseline(sql: RawDatabaseClient): Promise<void> {
  const baselineHash = migrationHash(await Bun.file(new URL("./migrations/0000_legacy_baseline.sql", import.meta.url)).text());
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext('whitesmith:migrations'))`;
    await tx`create schema if not exists drizzle`;
    await tx`create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )`;
    await tx`
      insert into drizzle.__drizzle_migrations(hash, created_at)
      select ${baselineHash}, ${baselineCreatedAt}
      where not exists (select 1 from drizzle.__drizzle_migrations where created_at=${baselineCreatedAt});
    `;
  });
}

export async function migrateDatabase(db: DatabaseClient): Promise<void> {
  const raw = db.$client ?? db;
  if (await hasApplicationSchema(raw)) await seedDrizzleBaseline(raw);
  await drizzleMigrate(drizzle(raw), { migrationsFolder });
}
