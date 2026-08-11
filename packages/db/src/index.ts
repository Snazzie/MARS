import postgres, { type Sql } from "postgres";
import { schemaSql } from "./schema.ts";

export function createDb(url: string): Sql<{}> { return postgres(url, { max: 10, prepare: false }); }
export async function migrate(sql: Sql<{}>): Promise<void> {
  await sql.begin(async tx => { await tx`select pg_advisory_xact_lock(hashtext('whitesmith:migrations'))`; for (const statement of schemaSql.split(';').map(s => s.trim()).filter(Boolean)) await tx.unsafe(statement); });
}
export { schemaSql };
export * from "./dashboard.ts";
