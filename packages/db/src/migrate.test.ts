import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { schemaSql } from "./schema.ts";

test("Drizzle baseline migration retains the legacy schema entrypoint", async () => {
  const baseline = await readFile(new URL("./migrations/0000_legacy_baseline.sql", import.meta.url), "utf8");
  expect(baseline).toContain("CREATE TABLE IF NOT EXISTS users");
  expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS users");
});

test("Drizzle migration journal includes the control-plane and run-attempt migrations", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  expect(journal.entries.map(entry => entry.tag)).toEqual(["0000_legacy_baseline", "0001_post_baseline", "0002_control_plane_config", "0002_github_run_attempt", "0003_linux_libvirt_driver"]);
  expect(journal.entries.every((entry, index) => index === 0 || entry.when > journal.entries[index - 1].when)).toBe(true);
});

test("run-attempt migration adds positive generation columns without rewriting unique keys", async () => {
  const migration = await readFile(new URL("./migrations/0002_github_run_attempt.sql", import.meta.url), "utf8");
  expect(migration).toContain("ALTER TABLE \"github_discovery_checkpoints\" ADD COLUMN \"completed_run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migration).toContain("ALTER TABLE \"dashboard_runs\" ADD COLUMN \"run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migration).toContain("ALTER TABLE \"dashboard_jobs\" ADD COLUMN \"run_attempt\" integer NOT NULL DEFAULT 1;");
  expect(migration).not.toContain("DROP CONSTRAINT");
  expect(migration).not.toContain("CREATE UNIQUE");
});
