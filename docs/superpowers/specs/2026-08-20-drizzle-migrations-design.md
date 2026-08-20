# Drizzle Migration Adoption Design

## Goal

Adopt Drizzle Kit and Drizzle ORM's PostgreSQL migration tooling for future schema changes without rewriting the existing tagged-SQL query layer or changing the deployed database schema.

## Scope

### In scope

- Add Drizzle ORM and Drizzle Kit to `packages/db`.
- Declare the current application schema in a Drizzle schema module.
- Add checked-in Drizzle migration files and package scripts.
- Introduce a migration runner used by production startup.
- Preserve the existing database table names, columns, constraints, indexes, and JSON shapes.
- Preserve existing installations and their current `schema_migrations` history.
- Add fresh-database, upgrade, idempotence, and migration-history tests.

### Out of scope

- Replacing existing `postgres` tagged-SQL queries.
- Rewriting repositories or database query helpers to Drizzle query APIs.
- Renaming tables, columns, environment variables, or storage paths.
- Changing application behavior unrelated to migrations.

## Compatibility strategy

The repository already has nine numbered custom migrations and deployed databases record them in `schema_migrations`. Those migrations become a frozen legacy boundary.

The transition has two phases:

1. **Compatibility phase:** startup runs the existing legacy migrations exactly once for installations that have not reached version 9, then initializes Drizzle's migration metadata at the version-9 boundary. New migrations are authored only as Drizzle migration files.
2. **Drizzle phase:** startup runs Drizzle migrations for all changes after the boundary. The legacy migration list is no longer extended.

The bridge must be explicit and idempotent. It must not mark the Drizzle baseline applied unless the legacy schema is at the expected version and the known legacy checksums pass. Fresh databases must create the complete baseline through a checked-in Drizzle baseline migration before applying post-baseline migrations.

The migration history must remain inspectable. A failed migration must fail startup and leave the database transactionally consistent.

## Files and interfaces

- `packages/db/drizzle.config.ts`: Drizzle Kit configuration using the PostgreSQL dialect, checked-in schema path, migration output directory, and `DATABASE_URL`.
- `packages/db/src/drizzle-schema.ts`: Drizzle table declarations matching the current schema without changing runtime query ownership.
- `packages/db/src/migrations/`: checked-in SQL generated or reviewed by Drizzle Kit.
- `packages/db/src/migrate.ts`: exported `migrateDatabase(sql)` compatibility runner; owns legacy bridge plus Drizzle migration invocation.
- `packages/db/package.json`: `db:generate`, `db:check`, and `db:migrate` scripts.
- `packages/db/src/index.ts`: exports the new migration entry point and keeps the existing `createDb` API.

## Fresh and existing database behavior

### Fresh database

- Drizzle migration metadata and baseline migration create the schema.
- Post-baseline migration files apply in order.
- No legacy custom migration array is needed for a fresh database.

### Existing database

- The bridge acquires the existing migration advisory lock.
- Legacy migrations complete through version 9 using the current checksum compatibility rules.
- The bridge verifies the final legacy version and checksums.
- The bridge initializes Drizzle migration metadata at the exact baseline boundary.
- Drizzle applies only migrations newer than the boundary.
- Repeated startup performs no schema work beyond metadata checks.

## Verification requirements

- Fresh PostgreSQL database reaches the same schema and passes existing DB tests.
- Database seeded through the current custom migration path upgrades without destructive SQL.
- Existing version/checksum records remain intact and are not silently rewritten.
- Repeated migration calls are idempotent.
- A deliberately malformed or checksum-mismatched legacy history fails startup.
- A new Drizzle migration is generated, applied, and observed in migration metadata.
- The control-plane image startup smoke uses the new migration entry point.

The final status must state that queries remain tagged SQL while migration ownership moves to Drizzle.
