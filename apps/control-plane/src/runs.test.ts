import { expect, test } from "bun:test";
import { applyGithubJobSnapshot, applyWorkflowJobWebhook, configureRunLifecycle, stageDurationMs, type GithubJobSnapshot, type GithubRunSnapshot, type GithubStepSnapshot } from "./runs.ts";

type RecordedQuery = { text: string; values: unknown[] };

function makeSqlRecorder() {
  const queries: RecordedQuery[] = [];
  const execute = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    queries.push({ text, values });
    if (text.includes("SELECT id,organization_id FROM dashboard_installations")) return [{ id: "installation", organization_id: "org" }];
    if (text.includes("SELECT id FROM dashboard_repositories")) return [{ id: "repository" }];
    if (text.startsWith("INSERT INTO dashboard_runs")) return [{ id: "run" }];
    if (text.startsWith("INSERT INTO dashboard_jobs")) return [{ id: "job" }];
    return [];
  };
  const sql = Object.assign(execute, {
    begin: async <T>(callback: (tx: typeof execute) => Promise<T>) => callback(execute),
  });
  return { sql, queries };
}

const run: GithubRunSnapshot = { id: 42, runNumber: 7, workflowName: "CI", event: "push", branch: "main", commitSha: "abc", actorLogin: "octocat", status: "queued", conclusion: null, queuedAt: "2026-08-13T00:00:00Z", startedAt: null, completedAt: null };
const step: GithubStepSnapshot = { id: null, number: 1, name: "build", status: "queued", conclusion: null, queuedAt: run.queuedAt, startedAt: null, completedAt: null, durationMs: 0 };
const job: GithubJobSnapshot = { id: 99, runId: run.id, name: "macos", status: "queued", conclusion: null, labels: [" self-hosted ", "macOS", "self-hosted"], runnerName: null, queuedAt: run.queuedAt, startedAt: null, completedAt: null, steps: [step] };

test("REST and workflow webhook share the transactional step persistence boundary", async () => {
  const recorder = makeSqlRecorder();
  configureRunLifecycle(recorder.sql as never);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  expect(await applyGithubJobSnapshot({ installationId: 5, repository, run, job })).toBe(true);
  expect(await applyWorkflowJobWebhook({
    installation: { id: 5 },
    repository: { id: repository.id, name: repository.name, full_name: repository.fullName },
    sender: { login: run.actorLogin },
    action: "queued",
    workflow_job: { id: job.id, run_id: run.id, run_number: run.runNumber, name: job.name, status: "queued", conclusion: null, created_at: run.queuedAt, started_at: run.startedAt, completed_at: null, runner_name: null, workflow_name: run.workflowName, head_branch: run.branch, head_sha: run.commitSha, event: run.event, labels: job.labels, steps: [{ number: 1, name: step.name, status: "queued", conclusion: null }] },
  })).toBe(true);

  const runWrites = recorder.queries.filter(query => query.text.startsWith("INSERT INTO dashboard_runs"));
  const jobWrites = recorder.queries.filter(query => query.text.startsWith("INSERT INTO dashboard_jobs"));
  const stepWrites = recorder.queries.filter(query => query.text.startsWith("INSERT INTO dashboard_job_steps"));
  expect(runWrites).toHaveLength(2);
  expect(jobWrites).toHaveLength(2);
  expect(stepWrites).toHaveLength(2);
  expect(JSON.stringify(runWrites[0])).toBe(JSON.stringify(runWrites[1]));
  expect(JSON.stringify(jobWrites[0])).toBe(JSON.stringify(jobWrites[1]));
  expect(JSON.stringify(stepWrites[0])).toBe(JSON.stringify(stepWrites[1]));

  const runSql = runWrites[0].text;
  const jobSql = jobWrites[0].text;
  const stepSql = stepWrites[0].text;
  expect(runSql).toContain("ON CONFLICT (organization_id,github_run_id)");
  expect(runSql).toContain("LEAST");
  expect(runSql).toContain("COALESCE");
  expect(jobSql).toContain("ON CONFLICT (organization_id,github_job_id)");
  expect(jobSql).toContain("status=CASE");
  expect(jobSql).toContain("COALESCE");
  expect(stepSql).toContain("ON CONFLICT (organization_id,run_id,job_id,number)");
  expect(stepSql).toContain("dashboard_job_steps.id=CAST(dashboard_job_steps.number AS text)");
  expect(stepSql).toContain("LEAST");
  expect(stepSql).toContain("COALESCE");
  expect(stepWrites[0].values).toContain(null);
  expect(stepWrites[0].values).toContain("1");
});

test("step duration is monotonic-compatible for terminal timestamps", () => {
  const terminal: GithubStepSnapshot = { id: "9", number: 1, name: "build", status: "completed", conclusion: "success", queuedAt: "2026-08-13T00:00:00Z", startedAt: "2026-08-13T00:01:00Z", completedAt: "2026-08-13T00:02:00Z", durationMs: 60_000 };
  expect(terminal.durationMs).toBe(stageDurationMs({ startedAt: terminal.startedAt!, completedAt: terminal.completedAt }));
});

test("queued steps never expose a start timestamp", () => {
  const queued: GithubStepSnapshot = { id: null, number: 1, name: "build", status: "queued", conclusion: null, queuedAt: "2026-08-13T00:00:00Z", startedAt: null, completedAt: null, durationMs: 0 };
  expect(queued.startedAt).toBeNull();
  expect(queued.completedAt).toBeNull();
});
