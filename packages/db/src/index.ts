import postgres, { type Sql as PostgresSql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import * as schema from "./drizzle-schema.ts";

export type RawDatabaseClient = PostgresSql<{}>;
export type DatabaseClient = RawDatabaseClient & Partial<PostgresJsDatabase<typeof schema>> & { $client?: RawDatabaseClient };
export type Sql<_ = {}> = DatabaseClient;
type DrizzleDatabase = PostgresJsDatabase<typeof schema>;

type QueryTag = <T extends readonly unknown[]>(strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<T>;

function wrapDatabase(orm: DrizzleDatabase, raw: RawDatabaseClient): DatabaseClient {
  const callable = function query<T extends readonly unknown[]>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T> {
    return orm.execute(drizzleSql(strings, ...values)) as unknown as Promise<T>;
  } as QueryTag & Record<string, unknown>;
  const proxy = new Proxy(callable, {
    get(_target, property) {
      if (property === "$client" || property === "end" || property === "json" || property === "unsafe") return raw[property as keyof RawDatabaseClient];
      if (property === "begin") return (callback: (tx: DatabaseClient) => Promise<unknown>) => orm.transaction(async tx => callback(wrapDatabase(tx as unknown as DrizzleDatabase, raw)));
      return (orm as unknown as Record<PropertyKey, unknown>)[property];
    },
  });
  return proxy as unknown as DatabaseClient;
}

export function createDb(url: string): DatabaseClient {
  const raw = postgres(url, { max: 10, prepare: false });
  return wrapDatabase(drizzle(raw, { schema }), raw);
}

export { migrateDatabase } from "./migrate.ts";
export { schemaSql } from "./schema.ts";
export * from "./json.ts";
export * from "./dashboard.ts";
export * from "./job-timing.ts";
export * from "./job-resource-telemetry.ts";
export * from "./onboarding.ts";
export * from "./leases.ts";
