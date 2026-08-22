import { expect, test } from "bun:test";
import { GithubJobsClient } from "./github-jobs.ts";

test("generates repository-scoped JIT config with labels", async () => {
  const requests: Request[] = [];
  const client = new GithubJobsClient({ token: async () => "installation-token", fetch: async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ encoded_jit_config: "secret-config" });
  }});
  const result = await client.generateJitConfig({ owner: "acme", repo: "project", runnerName: "ws-1", runnerGroupId: 7, workFolder: "_work", labels: ["self-hosted", "macos", "arm64", "whitesmith-default"] });
  expect(result.encodedJitConfig).toBe("secret-config");
  expect(requests[0].url).toBe("https://api.github.com/repos/acme/project/actions/runners/generate-jitconfig");
  expect(await requests[0].json()).toEqual({ name: "ws-1", runner_group_id: 7, work_folder: "_work", labels: ["self-hosted", "macos", "arm64", "whitesmith-default"] });
  expect(requests[0].headers.get("authorization")).toBe("Bearer installation-token");
});

test("does not hide a missing JIT config response", async () => {
  const client = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({}) });
  await expect(client.generateJitConfig({ owner: "acme", repo: "project", runnerName: "ws-1", runnerGroupId: 1, workFolder: "_work", labels: ["self-hosted"] })).rejects.toThrow("github_jit_config_missing");
});

test("normalizes attempt-qualified REST run and job snapshots", async () => {
  const requests: Request[] = [];
  const client = new GithubJobsClient({ token: async () => "token", fetch: async (input, init) => {
    requests.push(new Request(input, init));
    const url = String(input);
    if (url.endsWith("/actions/runs/1/attempts/2/jobs?per_page=100&page=1")) {
      return Response.json({ total_count: 1, jobs: [{ id: 2, run_id: 1, run_attempt: 2, status: "in_progress", name: "build", created_at: "2026-08-13T00:00:00Z", steps: [{ id: 9, number: 1, name: "Run", status: "queued", started_at: "2026-08-13T00:01:00Z" }] }] });
    }
    return Response.json({ id: 1, run_number: 1, run_attempt: 2, status: "in_progress", name: "CI", created_at: "2026-08-13T00:00:00Z" });
  } });
  const run = await client.getRun("acme", "project", 1);
  const result = await client.listJobs("acme", "project", 1, 2, 1);
  expect(run.runAttempt).toBe(2);
  expect(result.jobs[0]?.runAttempt).toBe(2);
  expect(requests[1]?.url).toBe("https://api.github.com/repos/acme/project/actions/runs/1/attempts/2/jobs?per_page=100&page=1");
  expect(result.jobs[0]?.steps[0]).toEqual({ id: "9", number: 1, name: "Run", status: "queued", conclusion: null, queuedAt: "2026-08-13T00:00:00Z", startedAt: null, completedAt: null, durationMs: 0 });
});

test("rejects attempt-qualified jobs whose run identity or attempt mismatches the request", async () => {
  const mismatchedRunId = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ jobs: [{ id: 2, run_id: 999, run_attempt: 2, status: "queued" }] }) });
  await expect(mismatchedRunId.listJobs("acme", "project", 1, 2, 1)).rejects.toThrow("github_payload_invalid");
  const mismatchedAttempt = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ jobs: [{ id: 2, run_id: 1, run_attempt: 1, status: "queued" }] }) });
  await expect(mismatchedAttempt.listJobs("acme", "project", 1, 2, 1)).rejects.toThrow("github_payload_invalid");
});
test("fetches an attempt-qualified run and rejects mismatched run pairs", async () => {
  const requests: string[] = [];
  const client = new GithubJobsClient({ token: async () => "token", fetch: async input => {
    requests.push(String(input));
    return Response.json({ id: 999, run_number: 1, run_attempt: 2, status: "queued" });
  } });
  await expect(client.getRunAttempt("acme", "project", 1, 2)).rejects.toThrow("github_payload_invalid");
  expect(requests[0]).toBe("https://api.github.com/repos/acme/project/actions/runs/1/attempts/2");
});

test("rejects missing or nonpositive REST run attempts", async () => {
  const missing = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ id: 1, status: "queued" }) });
  await expect(missing.getRun("acme", "project", 1)).rejects.toThrow("github_payload_invalid");
  const invalid = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ id: 1, run_attempt: 0, status: "queued" }) });
  await expect(invalid.getRun("acme", "project", 1)).rejects.toThrow("github_payload_invalid");
});

test("rejects missing or nonpositive REST job attempts", async () => {
  const missing = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ jobs: [{ id: 2, run_id: 1, status: "queued" }] }) });
  await expect(missing.listJobs("acme", "project", 1, 2, 1)).rejects.toThrow("github_payload_invalid");
  const invalid = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ jobs: [{ id: 2, run_id: 1, run_attempt: 1.5, status: "queued" }] }) });
  await expect(invalid.listJobs("acme", "project", 1, 2, 1)).rejects.toThrow("github_payload_invalid");
});

test("normalizes REST job steps and rejects malformed step payloads", async () => {
  const client = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ total_count: 1, jobs: [{ id: 2, run_id: 1, run_attempt: 2, status: "in_progress", name: "build", created_at: "2026-08-13T00:00:00Z", steps: [{ id: 9, number: 1, name: "Run", status: "queued", started_at: "2026-08-13T00:01:00Z" }] }] }) });
  const result = await client.listJobs("acme", "project", 1, 2, 1);
  expect(result.jobs[0]?.steps[0]).toEqual({ id: "9", number: 1, name: "Run", status: "queued", conclusion: null, queuedAt: "2026-08-13T00:00:00Z", startedAt: null, completedAt: null, durationMs: 0 });
  const malformed = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({ jobs: [{ id: 2, run_id: 1, run_attempt: 2, status: "queued", steps: [{ number: "nope", status: "queued" }] }] }) });
  await expect(malformed.listJobs("acme", "project", 1, 2, 1)).rejects.toThrow("github_payload_invalid");
});

test("downloads bounded GitHub-masked job logs as text", async () => {
  const requests: Request[] = [];
  const client = new GithubJobsClient({ token: async () => "token", fetch: async (input, init) => {
    requests.push(new Request(input, init));
    return new Response("2026-08-13T00:00:00Z token=***\n");
  } });

  expect(await client.getJobLogs("acme", "project", 42)).toContain("token=***");
  expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/project/actions/jobs/42/logs");
  expect(requests[0]?.headers.get("accept")).toBe("application/vnd.github+json");
});

test("rejects oversized GitHub job logs", async () => {
  const client = new GithubJobsClient({ token: async () => "token", fetch: async () => new Response("x".repeat(1025), { headers: { "content-length": "1025" } }) });
  await expect(client.getJobLogs("acme", "project", 42, 1024)).rejects.toThrow("github_job_log_too_large");
});
