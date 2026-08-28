# Migration Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace Mars’s historical PostgreSQL migration chain with one final baseline that bootstraps clean databases and fixes the missing webhook cleanup column.

**Architecture:** The final baseline is generated from `packages/db/src/schema.ts`’s complete `schemaSql`, with the missing `webhook_deliveries.state` column corrected in the source SQL. Drizzle’s migration journal contains only the new baseline. Startup database creation remains separate from schema migration.

**Tech Stack:** PostgreSQL 17, Drizzle ORM migrator, Bun tests, Windows PostgreSQL container.

## Global Constraints

- Reset the local `mars` database only after the new baseline is committed.
- Do not silently drop or mutate existing deployment databases.
- The baseline must execute successfully on an empty PostgreSQL database.
- The baseline must be safe to apply twice.
- Preserve all final tables, indexes, constraints, columns, and indexes represented by the current schema and migration SQL.

---

### Task 1: Final schema source

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/src/schema.test.ts`

- [ ] Add `state text NOT NULL DEFAULT 'pending'` to `webhook_deliveries` in the canonical schema SQL.
- [ ] Add a schema assertion that `schemaSql` contains the webhook state column and all required late-stage worker enrollment fields.
- [ ] Run `bun test packages/db/src/schema.test.ts`.
- [ ] Commit the canonical schema correction.

### Task 2: Replace migration history

**Files:**
- Delete: `packages/db/src/migrations/0000_legacy_baseline.sql` through `0010_worker_enrollment_replay.sql`
- Create: `packages/db/src/migrations/0000_mars_baseline.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Delete: superseded files in `packages/db/src/migrations/meta/`
- Test: `packages/db/src/migrate.test.ts`

- [ ] Materialize `schemaSql` as one SQL migration file with the final schema and no runtime placeholders.
- [ ] Replace the journal with one entry tagged `0000_mars_baseline`.
- [ ] Remove old migration metadata snapshots that refer to deleted migrations.
- [ ] Add a migration test asserting one journal entry and baseline presence.
- [ ] Run focused migration tests against a fresh database.
- [ ] Commit the consolidated migration history.

### Task 3: Fresh and existing database behavior

**Files:**
- Modify: `packages/db/src/migrate.ts` only if baseline detection requires adjustment.
- Test: `packages/db/src/migrate.test.ts`
- Test: `apps/control-plane/src/index.test.ts`

- [ ] Verify a clean database applies the single baseline and exposes `webhook_deliveries.state`.
- [ ] Verify a second migration run succeeds without changes.
- [ ] Verify startup still calls database creation before migration.
- [ ] Document that old-journal databases require explicit recreation or operator stamping.
- [ ] Run focused DB and control-plane tests.
- [ ] Commit behavior and documentation updates.

### Task 4: Local reset and proof

**Files:**
- No source changes expected.

- [ ] Drop and recreate only the local `mars` database using the Windows PostgreSQL container.
- [ ] Run `bun dev --kill` once; do not launch a second `bun dev` concurrently.
- [ ] Verify `GET http://localhost:3000/api/readyz` returns database and discovery checks true.
- [ ] Run the focused migration/control-plane test set and `git diff --check`.
- [ ] Record the reset and observed verification results.
