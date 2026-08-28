import { expect, test } from "bun:test";
import { initializeDatabase } from "./index.ts";

test("initializes the database only after ensuring it exists", async () => {
  const calls: string[] = [];
  const db = {} as never;
  const result = await initializeDatabase("postgres://user:password@db.example/mars", {
    ensureDatabase: async url => { calls.push(`ensure:${url}`); },
    createDb: url => { calls.push(`create:${url}`); return db; },
    migrateDatabase: async received => { calls.push(`migrate:${received === db}`); },
  });

  expect(result).toBe(db);
  expect(calls).toEqual([
    "ensure:postgres://user:password@db.example/mars",
    "create:postgres://user:password@db.example/mars",
    "migrate:true",
  ]);
});
