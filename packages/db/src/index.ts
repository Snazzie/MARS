import postgres, { type Sql } from "postgres";

export type DatabaseClient = Sql<{}>;
export function createDb(url: string): DatabaseClient { return postgres(url, { max: 10, prepare: false }); }

export { migrateDatabase } from "./migrate.ts";
export { schemaSql } from "./schema.ts";
export * from "./json.ts";
export * from "./dashboard.ts";
export * from "./job-timing.ts";
export * from "./job-resource-telemetry.ts";
export * from "./onboarding.ts";
export * from "./leases.ts";