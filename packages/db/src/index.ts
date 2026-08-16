import postgres, { type Sql } from "postgres";
import { createHash } from "node:crypto";
import { schemaSql } from "./schema.ts";

export type DatabaseClient = Sql<{}>;
export function createDb(url: string): DatabaseClient { return postgres(url, { max: 10, prepare: false }); }

type Migration = { version: number; name: string; sql: string };
const migrations: Migration[] = [
  { version: 1, name: "baseline", sql: schemaSql },
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
];

export async function migrate(sql: DatabaseClient): Promise<void> {
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext('whitesmith:migrations'))`;
    await tx`create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`;
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const [applied] = await tx<{ checksum: string }[]>`select checksum from schema_migrations where version=${migration.version}`;
      if (applied) {
        if (applied.checksum !== checksum) throw new Error(`migration_checksum_mismatch:${migration.version}`);
        continue;
      }
      for (const statement of migration.sql.split(";").map(s => s.trim()).filter(Boolean)) await tx.unsafe(statement);
      await tx`insert into schema_migrations (version,name,checksum) values (${migration.version},${migration.name},${checksum})`;
    }
  });
}
export { schemaSql };
export * from "./dashboard.ts";
export * from "./onboarding.ts";
export * from "./leases.ts";