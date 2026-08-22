import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { schemaSql } from "./schema.ts";

test("Drizzle baseline migration matches the frozen legacy schema", async () => {
  const baseline = await readFile(new URL("./migrations/0000_legacy_baseline.sql", import.meta.url), "utf8");
  expect(baseline).toBe(schemaSql);
});

test("Drizzle migration journal includes the run-attempt migration", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  expect(journal.entries.map(entry => entry.tag)).toEqual(["0000_legacy_baseline", "0001_post_baseline", "0002_github_run_attempt"]);
  expect(journal.entries[0].when).toBeLessThan(journal.entries[1].when);
  expect(journal.entries[1].when).toBeLessThan(journal.entries[2].when);
});

test("run-attempt migration adds positive generation columns without rewriting unique keys", async () => {
  const migration = await readFile(new URL("./migrations/0002_github_run_attempt.sql", import.meta.url), "utf8");
  expect(migration).toContain("ALTER TABLE \"github_discovery_checkpoints\" ADD COLUMN \"completed_run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migration).toContain("ALTER TABLE \"dashboard_runs\" ADD COLUMN \"run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migration).toContain("ALTER TABLE \"dashboard_jobs\" ADD COLUMN \"run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migration).toContain("CONSTRAINT \"github_discovery_checkpoints_completed_run_attempt_check\" CHECK (\"completed_run_attempt\" > 0)");
  expect(migration).toContain("CONSTRAINT \"dashboard_runs_run_attempt_check\" CHECK (\"run_attempt\" > 0)");
  expect(migration).toContain("CONSTRAINT \"dashboard_jobs_run_attempt_check\" CHECK (\"run_attempt\" > 0)");
  expect(migration).not.toContain("DROP CONSTRAINT");
  expect(migration).not.toContain("CREATE UNIQUE");
});
