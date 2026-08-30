import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, configureErrorFileLogging, formatJobReconciliationReport, resolveWebhookOrigin } from "./index.ts";

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

test("writes console errors to the configured control-plane log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-control-plane-log-"));
  const originalError = console.error;
  try {
    const logPath = configureErrorFileLogging(directory);
    console.error("pending worker failed", new Error("capacity missing"));
    const content = await readFile(logPath, "utf8");
    expect(content).toContain("pending worker failed");
    expect(content).toContain("capacity missing");
  } finally {
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps deferred-only reconciliation quiet", () => {
  expect(formatJobReconciliationReport({ reserved: 0, deferred: 4, skipped: 0, failed: 0 })).toBeUndefined();
});

test("reports successful reservations and unexpected failures", () => {
  expect(formatJobReconciliationReport({ reserved: 2, deferred: 1, skipped: 3, failed: 0 })).toBe("Job reconciliation tick: reserved=2 deferred=1 failed=0 skipped=3");
  expect(formatJobReconciliationReport({ reserved: 0, deferred: 0, skipped: 1, failed: 1 })).toBe("Job reconciliation tick: reserved=0 deferred=0 failed=1 skipped=1");
});
