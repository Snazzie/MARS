import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrateDatabase } from "./migrate.ts";
import type { DatabaseClient, RawDatabaseClient } from "./index.ts";

const migrationsUrl = new URL("./migrations/", import.meta.url);
const migration = (name: string) => readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");

function fakeDatabase(): DatabaseClient {
  return (() => Promise.resolve([])) as unknown as DatabaseClient;
}

test("migration directory contains only Drizzle-generated SQL and metadata", async () => {
  const files = (await readdir(migrationsUrl)).sort();
  const sqlFiles = files.filter(file => file.endsWith(".sql"));
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    dialect: string;
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  expect(sqlFiles).toHaveLength(1);
  expect(sqlFiles[0]).toMatch(/^0000_.+\.sql$/);
  expect(journal.dialect).toBe("postgresql");
  expect(journal.entries).toEqual([
    {
      idx: 0,
      version: "7",
      when: expect.any(Number),
      tag: sqlFiles[0]!.replace(/\.sql$/, ""),
      breakpoints: true,
    },
  ]);
});

test("generated baseline has a stable hash and required schema objects", async () => {
  const [file] = (await readdir(migrationsUrl)).filter(name => name.endsWith(".sql"));
  const sql = await migration(file!);
  expect(createHash("sha256").update(sql).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  expect(sql).toContain('CREATE TABLE "users"');
  expect(sql).toContain('CREATE TABLE "webhook_deliveries"');
  expect(sql).toContain('"state" text DEFAULT \'received\' NOT NULL');
});

test("migration runner delegates to Drizzle with the raw client", async () => {
  const calls: RawDatabaseClient[] = [];
  const raw = fakeDatabase();
  await migrateDatabase(raw, {
    runMigrations: async received => {
      calls.push(received);
    },
  });
  expect(calls).toEqual([raw]);
});
