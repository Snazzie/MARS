import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectWorkerServiceLogs, readWorkerServiceLogs, workerServiceLogPaths } from "./worker-service-logs.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

test("reads bounded service log tails and redacts credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-worker-logs-"));
  const path = join(directory, "worker.log");
  try {
    await writeFile(path, `${"old\n".repeat(100)}healthy\ntoken=secret-value\n`);
    const output = await readWorkerServiceLogs([path], 64);
    expect(output).toContain("healthy");
    expect(output).toContain("token=[REDACTED]");
    expect(output).not.toContain("secret-value");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(128);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collects a correlated worker log response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-worker-logs-"));
  const path = join(directory, "worker.log");
  try {
    await writeFile(path, "Mac worker command failed\n");
    const response = await collectWorkerServiceLogs({ id: commandId, workerId, leaseId: null, payload: { requestId, maxBytes: 1024 } }, [path]);
    expect(response).toMatchObject({ workerId, type: "worker.logs", payload: { commandId, requestId, content: expect.stringContaining("Mac worker command failed") } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses installed macOS worker log paths", () => {
  expect(workerServiceLogPaths("darwin", { HOME: "/Users/mars" })).toEqual([
    "/Users/mars/Library/Application Support/Mars/worker.log",
    "/Users/mars/Library/Application Support/Mars/worker.error.log",
  ]);
});
