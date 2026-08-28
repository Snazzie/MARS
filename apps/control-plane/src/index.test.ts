import { expect, test } from "bun:test";
import { initializeDatabase, resolveWebhookOrigin } from "./index.ts";

test("requires an explicit webhook origin at startup", () => {
  const previous = Bun.env.GITHUB_WEBHOOK_URL;
  delete Bun.env.GITHUB_WEBHOOK_URL;
  try {
    expect(() => resolveWebhookOrigin()).toThrow("GITHUB_WEBHOOK_URL is required");
  } finally {
    if (previous === undefined) delete Bun.env.GITHUB_WEBHOOK_URL;
    else Bun.env.GITHUB_WEBHOOK_URL = previous;
  }
});

test.each([
  "http://hooks.example.test",
  "https://localhost",
  "https://127.0.0.1",
  "https://192.168.1.20",
])("rejects non-public webhook origin %s", value => {
  expect(() => resolveWebhookOrigin(value)).toThrow(/GITHUB_WEBHOOK_URL/);
});

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
