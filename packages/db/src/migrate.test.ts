import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { schemaSql } from "./schema.ts";

const migrationsUrl = new URL("./migrations/", import.meta.url);
const migration = (name: string) => readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");

test("Mars baseline materializes the canonical schema SQL", async () => {
  const baseline = await migration("0000_mars_baseline.sql");

  expect(baseline.trim()).toBe(schemaSql.trim());
  expect(baseline).toContain(
    "CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id text PRIMARY KEY, installation_id bigint NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), event_name text NOT NULL DEFAULT 'unknown', state text NOT NULL DEFAULT 'received', attempt_count integer NOT NULL DEFAULT 0, last_error text, processed_at timestamptz);",
  );
  expect(baseline).toContain(
    "CREATE INDEX IF NOT EXISTS webhook_deliveries_state_idx ON webhook_deliveries(state, received_at);",
  );
});

test("migration directory contains exactly one journaled baseline", async () => {
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url))) as {
    entries: Array<{ idx: number; version: string; tag: string; when: number; breakpoints: boolean }>;
  };
  const files = (await readdir(migrationsUrl)).filter(file => file.endsWith(".sql"));

  expect(files).toEqual(["0000_mars_baseline.sql"]);
  expect(journal.entries).toEqual([
    {
      idx: 0,
      version: "7",
      when: 1700000000000,
      tag: "0000_mars_baseline",
      breakpoints: true,
    },
  ]);
});
