import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "./drizzle-schema.ts";

export type QueryDatabase = Omit<PostgresJsDatabase<typeof schema>, "query">;
type QueryFactory = (db: QueryDatabase) => unknown;
const factories: QueryFactory[] = [];
const prepared = new WeakMap<object, Map<QueryFactory, unknown>>();

/** Register a fixed query family. createDb compiles every family before serving requests. */
export function defineQueries<T>(factory: (db: QueryDatabase) => T): (db: object) => T {
  factories.push(factory);
  return (db) => {
    const queries = prepared.get(db);
    if (!queries?.has(factory)) throw new Error("Database queries were not initialized at startup; import query modules before creating the database client");
    return queries.get(factory) as T;
  };
}

export function initializeQueries(db: QueryDatabase): void {
  const queries = new Map<QueryFactory, unknown>();
  for (const factory of factories) queries.set(factory, factory(db));
  prepared.set(db, queries);
}
