import type { DatabaseClient } from "./index.ts";

export function jsonParameter(db: Pick<DatabaseClient, "json">, value: unknown): never {
  return db.json(value as never) as never;
}
