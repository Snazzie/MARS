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
  await (options.runMigrations ?? defaultMigrationRunner)(db.$client ?? db);
}
