import { expect, test } from "bun:test";
import { applyGithubJobSnapshot, applyWorkflowJobWebhook, configureRunLifecycle, stageDurationMs, type GithubJobSnapshot, type GithubRunSnapshot, type GithubStepSnapshot } from "./runs.ts";

type Row = Record<string, unknown>;
function makeStatefulSql() {
  const installations = [{ id: "installation", organization_id: "org" }];
  const repositories = [{ id: "repository" }];
  const runs = new Map<string, Row>();
  const jobs = new Map<string, Row>();
  const steps = new Map<string, Row>();
  const execute = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("SELECT id,organization_id FROM dashboard_installations")) return installations;
    if (text.includes("SELECT id FROM dashboard_repositories")) return repositories;
    if (text.startsWith("INSERT INTO dashboard_runs")) {
      const key = `${values[0]}:${values[2]}`;
      const incoming = { organization_id: values[0], repository_id: values[1], id: `run-${values[2]}`, github_run_id: values[2], status: values[9], conclusion: values[10], queued_at: values[11], started_at: values[12], completed_at: values[13] };
      const current = runs.get(key);
      if (!current) runs.set(key, incoming);
      else {
        if (current.status !== "completed" && (incoming.status === "completed" || (current.status === "queued" && incoming.status === "in_progress"))) current.status = incoming.status;
        current.conclusion ??= incoming.conclusion;
        current.queued_at = [current.queued_at, incoming.queued_at].sort()[0];
        current.started_at ??= incoming.started_at;
        current.completed_at ??= incoming.completed_at;
      }
      return [runs.get(key)!];
    }
    if (text.startsWith("INSERT INTO dashboard_jobs")) {
      const key = `${values[0]}:${values[2]}`;
      const incoming = { organization_id: values[0], run_id: values[1], id: `job-${values[2]}`, github_job_id: values[2], name: values[3], status: values[4], conclusion: values[5], stage: values[6], runner_name: values[7], requested_labels: values[8], queued_at: values[9], started_at: values[10], completed_at: values[11] };
      const current = jobs.get(key);
      if (!current) jobs.set(key, incoming);
      else {
        if (current.status !== "completed" && (incoming.status === "completed" || (current.status === "queued" && incoming.status === "in_progress"))) current.status = incoming.status;
        current.conclusion ??= incoming.conclusion;
        current.runner_name = incoming.runner_name ?? current.runner_name;
        current.queued_at = [current.queued_at, incoming.queued_at].sort()[0];
        current.started_at ??= incoming.started_at;
        current.completed_at ??= incoming.completed_at;
      }
      return [jobs.get(key)!];
    }
    if (text.startsWith("INSERT INTO dashboard_job_steps")) {
      const key = `${values[0]}:${values[1]}:${values[2]}:${values[5]}`;
      const incoming = { organization_id: values[0], run_id: values[1], job_id: values[2], id: values[3], name: values[4], number: values[5], status: values[6], conclusion: values[7], queued_at: values[8], started_at: values[9], completed_at: values[10], duration_ms: values[11] };
      const current = steps.get(key);
      if (!current) steps.set(key, incoming);
      else {
        if (String(current.id) === String(current.number) && String(incoming.id) !== String(incoming.number)) current.id = incoming.id;
        if (current.status !== "completed" && (incoming.status === "completed" || (current.status === "queued" && incoming.status === "in_progress"))) current.status = incoming.status;
        current.conclusion ??= incoming.conclusion;
        current.queued_at = [current.queued_at, incoming.queued_at].sort()[0];
        current.started_at ??= incoming.started_at;
        current.completed_at ??= incoming.completed_at;
      }
      return [steps.get(key)!];
    }
    return [];
  };
  const sql = Object.assign(execute, { begin: async <T>(callback: (tx: typeof execute) => Promise<T>) => callback(execute) });
  return { sql, runs, jobs, steps };
}

const queuedAt = "2026-08-13T00:00:00Z";
const run: GithubRunSnapshot = { id: 42, runNumber: 7, workflowName: "CI", event: "push", branch: "main", commitSha: "abc", actorLogin: "octocat", status: "queued", conclusion: null, queuedAt, startedAt: null, completedAt: null };
const step: GithubStepSnapshot = { id: null, number: 1, name: "build", status: "queued", conclusion: null, queuedAt, startedAt: null, completedAt: null, durationMs: 0 };
const job: GithubJobSnapshot = { id: 99, runId: run.id, name: "macos", status: "queued", conclusion: null, labels: [" self-hosted ", "macOS", "self-hosted"], runnerName: null, queuedAt, startedAt: null, completedAt: null, steps: [step] };

 test("REST and webhook updates execute one monotonic state machine", async () => {
  const fake = makeStatefulSql(); configureRunLifecycle(fake.sql as never);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  expect(await applyGithubJobSnapshot({ installationId: 5, repository, run, job })).toBe(true);
  expect(await applyWorkflowJobWebhook({ installation: { id: 5 }, repository: { id: 123, name: "repo", full_name: "acme/repo" }, sender: { login: "octocat" }, action: "queued", workflow_job: { id: 99, run_id: 42, run_number: 7, name: "macos", status: "queued", created_at: queuedAt, workflow_name: "CI", head_branch: "main", head_sha: "abc", event: "push", labels: job.labels, steps: [{ number: 1, name: "build", status: "queued" }] } })).toBe(true);
  const key = "org:99"; expect(fake.jobs.get(key)?.status).toBe("queued"); expect(fake.jobs.get(key)?.started_at).toBeNull(); expect(fake.jobs.get(key)?.requested_labels).toBe('["self-hosted","macos"]'); expect(fake.steps.size).toBe(1);
  const started = { ...run, status: "in_progress" as const, startedAt: "2026-08-13T00:01:00Z" }; const runningJob = { ...job, status: "in_progress" as const, startedAt: started.startedAt, runnerName: "runner" }; await applyGithubJobSnapshot({ installationId: 5, repository, run: started, job: runningJob });
  const completed = { ...started, status: "completed" as const, conclusion: "success", completedAt: "2026-08-13T00:02:00Z" }; const doneJob = { ...runningJob, status: "completed" as const, conclusion: "success", completedAt: completed.completedAt, steps: [{ ...step, id: null, status: "completed" as const, conclusion: "success", startedAt: started.startedAt, completedAt: completed.completedAt, durationMs: 60_000 }] }; await applyGithubJobSnapshot({ installationId: 5, repository, run: completed, job: doneJob });
  await applyGithubJobSnapshot({ installationId: 5, repository, run: started, job: runningJob });
  expect(fake.jobs.get(key)?.status).toBe("completed"); expect(fake.jobs.get(key)?.started_at).toBe(started.startedAt); expect(fake.jobs.get(key)?.completed_at).toBe(completed.completedAt); expect(fake.steps.get("org:run-42:job-99:1")?.status).toBe("completed");
  const stable = { ...doneJob, steps: [{ ...doneJob.steps[0], id: "gh-step-1" }] }; await applyGithubJobSnapshot({ installationId: 5, repository, run: completed, job: stable }); expect(fake.steps.get("org:run-42:job-99:1")?.id).toBe("gh-step-1");
 });

test("step duration is monotonic-compatible for terminal timestamps", () => expect(stageDurationMs({ startedAt: "2026-08-13T00:01:00Z", completedAt: "2026-08-13T00:02:00Z" })).toBe(60_000));
test("strict webhook step validation remains enforced", async () => { await expect(applyWorkflowJobWebhook({ installation: { id: 5 }, repository: { id: 123 }, workflow_job: { id: 99, run_id: 42, status: "queued", steps: [{ number: 0 }] } })).rejects.toThrow("github_payload_invalid"); });
