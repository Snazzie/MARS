import type { Sql } from "postgres";

export function jsonParameter(sql: Pick<Sql<{}>, "json">, value: unknown): never {
  return (typeof sql.json === "function" ? sql.json(value as never) : value) as never;
}
