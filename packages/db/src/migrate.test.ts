import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { schemaSql } from "./schema.ts";

test("Drizzle baseline migration matches the frozen legacy schema", async () => {
  const baseline = await readFile(new URL("./migrations/0000_legacy_baseline.sql", import.meta.url), "utf8");
  expect(baseline).toBe(schemaSql);
});

test("Drizzle migration journal has a frozen baseline and post-boundary entry", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  expect(journal.entries.map(entry => entry.tag)).toEqual(["0000_legacy_baseline", "0001_post_baseline"]);
  expect(journal.entries[0].when).toBeLessThan(journal.entries[1].when);
});
