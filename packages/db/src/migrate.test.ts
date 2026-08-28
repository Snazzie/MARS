import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { schemaSql } from "./schema.ts";

const migration = (name: string) => readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");

test("Drizzle baseline migration retains the legacy schema entrypoint", async () => {
  const baseline = await migration("0000_legacy_baseline.sql");
  expect(baseline).toContain("CREATE TABLE IF NOT EXISTS users");
  expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS users");
});

test("migration lineage preserves released history and converges exactly once", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  expect(journal.entries.map(entry => entry.tag)).toEqual([
    "0000_legacy_baseline",
    "0001_post_baseline",
    "0002_github_run_attempt",
    "0003_control_plane_config",
    "0004_linux_libvirt_driver",
    "0005_worker_preserve_leases",
    "0006_worker_action_cache",
    "0007_repair_worker_cache_snapshot_staging",
    "0008_repair_worker_cache_snapshot_status",
    "0009_mars_runner_labels",
    "0010_worker_enrollment_replay",
  ]);
  expect(new Set(journal.entries.map(entry => entry.tag.slice(0, 4))).size).toBe(journal.entries.length);
  expect(new Set(journal.entries.map(entry => entry.when)).size).toBe(journal.entries.length);
  expect(journal.entries.every((entry, index) => index === 0 || entry.when > journal.entries[index - 1].when)).toBe(true);
  expect(journal.entries[2]?.when).toBe(1700000002000);
});

test("worker cache staging repair migration restores the sweep column", async () => {
  const migrationText = await migration("0007_repair_worker_cache_snapshot_staging.sql");
  expect(migrationText).toContain('ALTER TABLE "worker_cache_snapshot_entries" ADD COLUMN IF NOT EXISTS "staged_at" timestamptz NOT NULL DEFAULT now();');
  expect(migrationText).toContain('CREATE INDEX IF NOT EXISTS "worker_cache_snapshot_entries_staged_at_idx" ON "worker_cache_snapshot_entries"("staged_at");');
});

test("worker cache status repair migration restores snapshot lifecycle columns", async () => {
  const migrationText = await migration("0008_repair_worker_cache_snapshot_status.sql");
  expect(migrationText).toContain('ALTER TABLE "worker_cache_status" ADD COLUMN IF NOT EXISTS "active_snapshot_id" uuid;');
  expect(migrationText).toContain('ALTER TABLE "worker_cache_status" ADD COLUMN IF NOT EXISTS "active_snapshot_started_at" timestamptz;');
  expect(migrationText).toContain('ALTER TABLE "worker_cache_status" ADD COLUMN IF NOT EXISTS "last_completed_snapshot_id" uuid;');
});

test("worker enrollment replay migration adds nullable authentication evidence", async () => {
  const migrationText = await migration("0010_worker_enrollment_replay.sql");
  expect(migrationText).toContain('ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "enrollment_code_hash" bytea;');
  expect(migrationText).toContain('ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "enrollment_authenticated_at" timestamptz;');
});

test("released run-attempt migration remains non-destructive", async () => {
  const migrationText = await migration("0002_github_run_attempt.sql");
  expect(migrationText).toContain("ALTER TABLE \"github_discovery_checkpoints\" ADD COLUMN \"completed_run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migrationText).toContain("ALTER TABLE \"dashboard_runs\" ADD COLUMN \"run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migrationText).toContain("ALTER TABLE \"dashboard_jobs\" ADD COLUMN \"run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migrationText).not.toContain("DROP CONSTRAINT");
  expect(migrationText).not.toContain("CREATE UNIQUE");
});

test("worker lease preservation migration is idempotent", async () => {
  const migrationText = await migration("0005_worker_preserve_leases.sql");
  expect(migrationText).toBe('ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "preserve_leases" boolean NOT NULL DEFAULT false;\n');
});

test("convergence migration is idempotent across both historical branches", async () => {
  const migrationText = await migration("0003_control_plane_config.sql");
  expect(migrationText).toContain('CREATE TABLE IF NOT EXISTS "control_plane_config"');
  expect(migrationText.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(3);
  for (const constraint of [
    "github_discovery_checkpoints_completed_run_attempt_check",
    "dashboard_runs_run_attempt_check",
    "dashboard_jobs_run_attempt_check",
  ]) {
    expect(migrationText).toContain(`conname = '${constraint}'`);
    expect(migrationText).toContain(`ADD CONSTRAINT "${constraint}"`);
  }
  expect(migrationText.indexOf("CREATE TABLE IF NOT EXISTS")).toBeLessThan(migrationText.indexOf("ADD COLUMN IF NOT EXISTS"));
  expect(migrationText.indexOf("ADD COLUMN IF NOT EXISTS")).toBeLessThan(migrationText.indexOf("DO $$"));
});
