import { describe, expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { chunkLogText, syncCompletedGithubJobLogs } from "./github-job-log-sync.ts";
import type { GithubJobSnapshot } from "./runs.ts";

const job: GithubJobSnapshot = {
  id: 42,
  runId: 7,
  runAttempt: 1,
  name: "build",
  status: "completed",
  conclusion: "success",
  labels: ["ubuntu-latest"],
  runnerName: "GitHub Actions 1",
  queuedAt: "2026-08-13T00:00:00Z",
  startedAt: "2026-08-13T00:00:01Z",
  completedAt: "2026-08-13T00:00:05Z",
  steps: [{ id: null, number: 1, name: "Build", status: "completed", conclusion: "success", queuedAt: "2026-08-13T00:00:01Z", startedAt: "2026-08-13T00:00:02Z", completedAt: "2026-08-13T00:00:04Z", durationMs: 2_000 }],
};

function fakeDb() {
  const calls: string[] = [];
  const db = preparedTestDatabase(name => {
    calls.push(name);
    if (name === "github_job_logs_candidate") return [{ id: "44444444-4444-4444-8444-444444444444", logsState: "pending", logsVersion: 0 }];
    if (name === "github_job_logs_locked") return [{ id: "44444444-4444-4444-8444-444444444444", organizationId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", logsState: "pending", logsVersion: 0 }];
    if (name === "github_job_logs_steps") return [{ id: "33333333-3333-4333-8333-333333333333", number: 1 }];
    return [];
  });
  return { db, calls };
}

test("chunks logs on UTF-8 boundaries without exceeding the event budget", () => {
  const chunks = chunkLogText("aa😀bb😀cc", 6);
  expect(chunks.join("")).toBe("aa😀bb😀cc");
  expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 6)).toBe(true);
});

describe("completed GitHub job log synchronization", () => {
  test("replaces transient worker output with canonical attributed GitHub logs", async () => {
    const { db, calls } = fakeDb();
    const synced = await syncCompletedGithubJobLogs({
      db,
      client: { getJobLogs: async () => "2026-08-13T00:00:01.500Z setup\n2026-08-13T00:00:02.500Z build output\n2026-08-13T00:00:04.500Z cleanup\n" },
      owner: "acme",
      repo: "project",
      job,
    });

    expect(synced).toBe(true);
    expect(calls).toContain("github_job_logs_delete_steps");
    expect(calls).toContain("github_job_logs_insert_step");
    expect(calls).toContain("github_job_logs_insert_job");
    expect(calls).toContain("github_job_logs_mark_ingested");
  });

  test("marks expired GitHub logs unavailable without blocking discovery forever", async () => {
    const { db, calls } = fakeDb();
    const synced = await syncCompletedGithubJobLogs({
      db,
      client: { getJobLogs: async () => { throw new Error("github_404"); } },
      owner: "acme",
      repo: "project",
      job,
    });

    expect(synced).toBe(false);
    expect(calls).toContain("github_job_logs_unavailable");
  });

  test("retries a recent completed job while GitHub is still preparing logs", async () => {
    const { db, calls } = fakeDb();
    await expect(syncCompletedGithubJobLogs({
      db,
      client: { getJobLogs: async () => { throw new Error("github_404"); } },
      owner: "acme",
      repo: "project",
      job: { ...job, completedAt: "2026-08-13T00:09:00Z" },
      now: () => Date.parse("2026-08-13T00:10:00Z"),
    })).rejects.toThrow("github_job_logs_not_ready");

    expect(calls).not.toContain("github_job_logs_unavailable");
  });
});
