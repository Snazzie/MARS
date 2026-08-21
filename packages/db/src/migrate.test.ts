import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { schemaSql } from "./schema.ts";

test("Drizzle baseline migration retains the legacy schema entrypoint", async () => {
  const baseline = await readFile(new URL("./migrations/0000_legacy_baseline.sql", import.meta.url), "utf8");
  expect(baseline).toContain("CREATE TABLE IF NOT EXISTS users");
  expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS users");
});

test("Drizzle migration journal includes the control-plane config migration", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  expect(journal.entries.map(entry => entry.tag)).toEqual(["0000_legacy_baseline", "0001_post_baseline", "0002_control_plane_config"]);
  expect(journal.entries[0].when).toBeLessThan(journal.entries[1].when);
  expect(journal.entries[1].when).toBeLessThan(journal.entries[2].when);
});
