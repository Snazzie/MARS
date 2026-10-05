import postgres, { type Sql as PostgresSql, type TransactionSql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { AsyncLocalStorage } from "node:async_hooks";
import { TransactionRollbackError } from "drizzle-orm";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import { initializeQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";

export type RawDatabaseClient = PostgresSql<{}>;
type DrizzleDatabase = Omit<PostgresJsDatabase<typeof schema>, "query" | "transaction">;
export type DatabaseClient = DrizzleDatabase & {
  $client: RawDatabaseClient;
  transaction<T>(callback: (tx: DatabaseClient) => Promise<T>, config?: PgTransactionConfig): Promise<T>;
  rollback(): never;
};

/** Prepared Drizzle statements retain this client, which routes execution to the active transaction. */
export function createDbFromClient(raw: RawDatabaseClient): DatabaseClient {
  const transactions = new AsyncLocalStorage<TransactionSql<{}>>();
  const routed = new Proxy(raw, {
    get(target, property) {
      if (property === "unsafe") return (...args: Parameters<RawDatabaseClient["unsafe"]>) => {
        const client = transactions.getStore() ?? target;
        return client.unsafe(...args);
      };
      return Reflect.get(target, property);
    },
  });
  const db = drizzle(routed, { schema }) as unknown as DatabaseClient;
  Object.defineProperty(db, "$client", { get: () => transactions.getStore() ?? raw });
  db.rollback = () => { throw new TransactionRollbackError(); };
  db.transaction = async (callback, config) => {
    const current = transactions.getStore();
    if (current) {
      if (config) throw new Error("Nested transaction configuration is unsupported");
      return current.savepoint((tx) => transactions.run(tx, () => callback(db))) as ReturnType<typeof callback>;
    }
    const options = [
      config?.isolationLevel ? `isolation level ${config.isolationLevel}` : "",
      config?.accessMode ?? "",
      config?.deferrable === undefined ? "" : config.deferrable ? "deferrable" : "not deferrable",
    ].filter(Boolean).join(" ");
    return raw.begin(options, (tx) => transactions.run(tx, () => callback(db))) as ReturnType<typeof callback>;
  };
  initializeQueries(db as unknown as PostgresJsDatabase<typeof schema>);
  return db;
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
  return createDbFromClient(raw);
}

export { migrateDatabase } from "./migrate.ts";
export { defineQueries } from "./prepared.ts";
export { schema };
export * from "./dashboard.ts";
export * from "./github-runner-cost.ts";
export * from "./worker-cache.ts";
export * from "./job-timing.ts";
export * from "./job-resource-telemetry.ts";
export * from "./job-resource-trends.ts";
export * from "./job-label-recommendations.ts";
export * from "./onboarding.ts";
export * from "./leases.ts";
