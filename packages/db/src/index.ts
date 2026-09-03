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
      if (property === "$client") return raw;
      if (property === "end" || property === "json" || property === "unsafe") return raw[property as keyof RawDatabaseClient];
      if (property === "begin") return (callback: (tx: DatabaseClient) => Promise<unknown>) => orm.transaction(async tx => callback(wrapDatabase(tx as unknown as DrizzleDatabase, raw)));
      return (orm as unknown as Record<PropertyKey, unknown>)[property];
    },
  });
  return proxy as unknown as DatabaseClient;
}

const defaultConnectionFactory = (url: string): RawDatabaseClient => postgres(url, { max: 1, prepare: false });

export type DatabaseConnectionFactory = (url: string) => RawDatabaseClient;
export type EnsureDatabaseOptions = { connect?: DatabaseConnectionFactory; connectionFactory?: DatabaseConnectionFactory };

function databaseNameFromUrl(databaseUrl: string): { name: string; maintenanceUrl: string } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch (error) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL", { cause: error });
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme");
  }
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice(1));
  } catch (error) {
    throw new Error("DATABASE_URL contains an invalid database identifier", { cause: error });
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(name)) {
    throw new Error("DATABASE_URL contains an invalid database identifier");
  }
  url.pathname = "/postgres";
  return { name, maintenanceUrl: url.toString() };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll(`"`, `""`)}"`;
}


export async function ensureDatabase(databaseUrl: string, options: EnsureDatabaseOptions | DatabaseConnectionFactory = {}): Promise<void> {
  const { name, maintenanceUrl } = databaseNameFromUrl(databaseUrl);
  const connect = typeof options === "function" ? options : options.connectionFactory ?? options.connect ?? defaultConnectionFactory;
  let maintenance: RawDatabaseClient;
  try {
    maintenance = connect(maintenanceUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not connect to PostgreSQL maintenance database: ${detail}`, { cause: error });
  }
  try {
    const rows = await maintenance<{ datname: string }[]>`select datname from pg_database where datname=${name}`;
    if (rows.length > 0) return;
    try {
      await maintenance.unsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
    } catch (error) {
      if (postgresErrorCode(error) === "42P04") return;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not create PostgreSQL database "${name}": ${detail}`, { cause: error });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("could not create PostgreSQL database")) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not inspect PostgreSQL database "${name}": ${detail}`, { cause: error });
  } finally {
    await maintenance.end({ timeout: 5 });
  }
}


export function createDb(url: string): DatabaseClient {
  const raw = postgres(url, { max: 10, prepare: false });
  return wrapDatabase(drizzle(raw, { schema }), raw);
}

export { migrateDatabase } from "./migrate.ts";
export { schemaSql } from "./schema.ts";
export * from "./json.ts";
export * from "./dashboard.ts";
export * from "./worker-cache.ts";
export * from "./job-timing.ts";
export * from "./job-resource-telemetry.ts";
export * from "./job-resource-trends.ts";
export * from "./job-label-recommendations.ts";
export * from "./onboarding.ts";
export * from "./leases.ts";
