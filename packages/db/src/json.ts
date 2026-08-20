import type { DatabaseClient } from "./index.ts";

export function jsonParameter(db: Pick<DatabaseClient, "json">, value: unknown): never {
  if ((db as DatabaseClient).$client) return JSON.stringify(value) as never;
  return (typeof db.json === "function" ? db.json(value as never) : value) as never;
}
