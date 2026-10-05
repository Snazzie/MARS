import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { applyGithubJobSnapshot, applyWorkflowJobWebhook, configureRunLifecycle, markGithubJobMissing, stageDurationMs, type GithubJobSnapshot, type GithubRunSnapshot, type GithubStepSnapshot } from "./runs.ts";

type Row = Record<string, unknown>;
function makeStatefulSql() {
  const installations = [{ id: "installation", organizationId: "org" }];
  const repositories = [{ id: "repository" }];
  const runs = new Map<string, Row>();
  const jobs = new Map<string, Row>();
  const steps = new Map<string, Row>();
  let repositoryAvailable = true;
  const sql = preparedTestDatabase((name, values) => {
    if (name === "run_lifecycle_installation") return installations;
    if (name === "run_lifecycle_repository") return repositoryAvailable ? repositories : [];
    if (name === "run_lifecycle_mark_job_missing") {
      const current = jobs.get(`${values.organizationId}:${values.githubJobId}`);
      if (!current || current.status === "completed") return [];
      Object.assign(current, { status: "completed", stage: "failed", conclusion: "cancelled", completed_at: values.observedAt });
      return [{ id: current.id }];
    }
    if (name === "run_lifecycle_revive_run") {
      const current = runs.get(`${values.organizationId}:${values.githubRunId}`);
      if (current && current.run_attempt === values.runAttempt && current.status === "completed" && !jobs.has(`${values.organizationId}:${values.githubJobId}`)) {
        Object.assign(current, { status: current.started_at ? "in_progress" : "queued", conclusion: null, completed_at: null });
      }
      return [];
    }
    if (name === "run_lifecycle_invalidate_graph") return [];
    if (name === "run_lifecycle_reset_queued_run" || name === "run_lifecycle_reset_active_run") {
      const current = runs.get(`${values.organizationId}:${values.githubRunId}`);
      if (current && current.run_attempt === values.runAttempt && current.status === "completed") {
        Object.assign(current, name.endsWith("queued_run")
          ? { status: "queued", conclusion: null, queued_at: values.queuedAt, started_at: null, completed_at: null }
          : { status: values.status, conclusion: values.conclusion, queued_at: values.queuedAt, started_at: values.startedAt, completed_at: values.completedAt });
      }
      return [];
    }
    if (name === "run_lifecycle_reset_queued_job" || name === "run_lifecycle_reset_active_job") {
      const current = jobs.get(`${values.organizationId}:${values.githubJobId}`);
      if (current && current.run_attempt === values.runAttempt && current.status === "completed") {
        Object.assign(current, name.endsWith("queued_job")
          ? { status: "queued", conclusion: null, stage: "queued", queued_at: values.queuedAt, started_at: null, completed_at: null }
          : { status: values.status, conclusion: values.conclusion, stage: values.stage, queued_at: values.queuedAt, started_at: values.startedAt, completed_at: values.completedAt });
      }
      return [];
    }
    if (name === "run_lifecycle_upsert_run") {
      const key = `${values.organizationId}:${values.githubRunId}`;
      const incoming = {
        organization_id: values.organizationId, repository_id: values.repositoryId, id: `run-${values.githubRunId}`, github_run_id: values.githubRunId,
        run_attempt: values.runAttempt, status: values.status, conclusion: values.conclusion, queued_at: values.queuedAt, started_at: values.startedAt, completed_at: values.completedAt,
      };
      const current = runs.get(key);
      if (!current || Number(values.runAttempt) > Number(current.run_attempt)) runs.set(key, incoming);
      else if (Number(values.runAttempt) === Number(current.run_attempt)) {
        const authoritativeRepair = values.authoritative === true && values.status !== "completed";
        if (authoritativeRepair) Object.assign(current, incoming);
        else {
          const wasTerminal = current.status === "completed";
          if (!wasTerminal && (values.status === "completed" || current.status === "queued" && values.status === "in_progress")) current.status = values.status;
          current.conclusion ??= values.conclusion;
          current.queued_at = [current.queued_at, values.queuedAt].sort()[0];
          current.started_at = current.started_at && values.startedAt ? [current.started_at, values.startedAt].sort()[0] : current.started_at ?? values.startedAt;
          if (!wasTerminal && (!current.completed_at || values.completedAt && String(values.completedAt) > String(current.completed_at))) current.completed_at = values.completedAt;
        }
      }
      return [{ id: runs.get(key)!.id }];
    }
    if (name === "run_lifecycle_complete_jobs") {
      for (const current of jobs.values()) {
        if (current.organization_id !== values.organizationId || current.run_id !== values.runId || current.run_attempt !== values.runAttempt || current.status === "completed") continue;
        Object.assign(current, { status: "completed", conclusion: current.conclusion ?? values.conclusion, completed_at: current.completed_at ?? values.completedAt });
      }
      return [];
    }
    if (name === "run_lifecycle_upsert_job") {
      const key = `${values.organizationId}:${values.githubJobId}`;
      const incoming = {
        organization_id: values.organizationId, run_id: values.runId, id: `job-${values.githubJobId}`, github_job_id: values.githubJobId,
        run_attempt: values.runAttempt, name: values.name, status: values.status, conclusion: values.conclusion, stage: values.stage,
        runner_name: values.runnerName, requested_labels: values.labels, queued_at: values.queuedAt, started_at: values.startedAt, completed_at: values.completedAt,
      };
      const current = jobs.get(key);
      if (!current || Number(values.runAttempt) > Number(current.run_attempt)) jobs.set(key, incoming);
      else if (Number(values.runAttempt) === Number(current.run_attempt)) {
        if (values.authoritative === true && values.status !== "completed") Object.assign(current, incoming);
        else {
          if (current.status !== "completed" && (values.status === "completed" || current.status === "queued" && values.status === "in_progress")) current.status = values.status;
          current.conclusion ??= values.conclusion;
          current.runner_name = values.runnerName ?? current.runner_name;
          current.queued_at = [current.queued_at, values.queuedAt].sort()[0];
          current.started_at = current.started_at && values.startedAt ? [current.started_at, values.startedAt].sort()[0] : current.started_at ?? values.startedAt;
          current.completed_at ??= values.completedAt;
        }
      }
      return [{ id: jobs.get(key)!.id }];
    }
    if (name === "run_lifecycle_upsert_step") {
      const key = `${values.organizationId}:${values.runId}:${values.jobId}:${values.number}`;
      const incoming = { organization_id: values.organizationId, run_id: values.runId, job_id: values.jobId, id: values.id, name: values.name, number: values.number, status: values.status, conclusion: values.conclusion, queued_at: values.queuedAt, started_at: values.startedAt, completed_at: values.completedAt, duration_ms: values.durationMs };
      const current = steps.get(key);
      if (!current) steps.set(key, incoming);
      else {
        if (!String(current.id).includes("-")) current.id = values.id;
        if (current.status !== "completed" && (values.status === "completed" || current.status === "queued" && values.status === "in_progress")) current.status = values.status;
        current.conclusion ??= values.conclusion;
        current.queued_at = [current.queued_at, values.queuedAt].sort()[0];
        const started = current.started_at && values.startedAt ? [current.started_at, values.startedAt].sort()[0] : current.started_at ?? values.startedAt;
        const completed = current.completed_at ?? values.completedAt;
        current.duration_ms = Math.max(Number(current.duration_ms ?? 0), Number(values.durationMs ?? 0), started && completed ? Date.parse(String(completed)) - Date.parse(String(started)) : 0);
        current.started_at = started;
        current.completed_at = completed;
      }
      return [];
    }
    return [];
  });
  return { sql, runs, jobs, steps, set repositoryAvailable(value: boolean) { repositoryAvailable = value; } };
}

const queuedAt = "2026-08-13T00:00:00Z";
const run: GithubRunSnapshot = { id: 42, runAttempt: 1, runNumber: 7, workflowName: "CI", event: "push", branch: "main", commitSha: "abc", actorLogin: "octocat", status: "queued", conclusion: null, queuedAt, startedAt: null, completedAt: null };
const step: GithubStepSnapshot = { id: null, number: 1, name: "build", status: "queued", conclusion: null, queuedAt, startedAt: null, completedAt: null, durationMs: 0 };
const job: GithubJobSnapshot = { id: 99, runId: run.id, runAttempt: 1, name: "macos", status: "queued", conclusion: null, labels: [" self-hosted ", "macOS", "self-hosted"], runnerName: null, queuedAt, startedAt: null, completedAt: null, steps: [step] };

 test("REST and webhook updates execute one monotonic state machine", async () => {
  const fake = makeStatefulSql(); configureRunLifecycle(fake.sql);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  expect(await applyGithubJobSnapshot({ installationId: 5, repository, run, job })).toBe(true);
  expect(fake.runs.get("org:42")?.status).toBe("queued");
  expect(await applyWorkflowJobWebhook({ installation: { id: 5 }, repository: { id: 123, name: "repo", full_name: "acme/repo" }, sender: { login: "octocat" }, action: "queued", workflow_job: { id: 99, run_id: 42, run_attempt: 1, run_number: 7, name: "macos", status: "queued", created_at: queuedAt, workflow_name: "CI", head_branch: "main", head_sha: "abc", event: "push", labels: job.labels, steps: [{ number: 1, name: "build", status: "queued" }] } })).toBe(true);
  const key = "org:99"; expect(fake.runs.get("org:42")?.status).toBe("queued"); expect(fake.jobs.get(key)?.status).toBe("queued"); expect(fake.jobs.get(key)?.started_at).toBeNull(); expect(fake.jobs.get(key)?.requested_labels).toEqual(["self-hosted", "macos"]); expect(fake.steps.size).toBe(1);
  const started = { ...run, status: "in_progress" as const, startedAt: "2026-08-13T00:02:00Z" }; const runningJob = { ...job, status: "in_progress" as const, startedAt: started.startedAt, runnerName: "runner" }; await applyGithubJobSnapshot({ installationId: 5, repository, run: started, job: runningJob });
  expect(fake.runs.get("org:42")?.status).toBe("in_progress"); expect(fake.runs.get("org:42")?.started_at).toBe(started.startedAt);
  const completed = { ...started, status: "completed" as const, conclusion: "success", completedAt: "2026-08-13T00:04:00Z" }; const doneJob = { ...runningJob, status: "completed" as const, conclusion: "success", completedAt: completed.completedAt, steps: [{ ...step, id: null, status: "completed" as const, conclusion: "success", startedAt: started.startedAt, completedAt: completed.completedAt, durationMs: 120_000 }] }; await applyGithubJobSnapshot({ installationId: 5, repository, run: completed, job: doneJob });
  const stale = { ...completed, startedAt: "2026-08-13T00:01:00Z", completedAt: "2026-08-13T00:03:00Z" }; const staleStep = { ...doneJob.steps[0], id: null, startedAt: stale.startedAt, completedAt: stale.completedAt, durationMs: 1_000 }; await applyGithubJobSnapshot({ installationId: 5, repository, run: stale, job: { ...doneJob, startedAt: stale.startedAt, completedAt: stale.completedAt, steps: [staleStep] } });
  expect(fake.runs.get("org:42")?.status).toBe("completed"); expect(fake.runs.get("org:42")?.started_at).toBe("2026-08-13T00:01:00Z"); expect(fake.runs.get("org:42")?.completed_at).toBe(completed.completedAt);
  const storedStep = fake.steps.get("org:run-42:job-99:1"); expect(fake.jobs.get(key)?.status).toBe("completed"); expect(fake.jobs.get(key)?.started_at).toBe("2026-08-13T00:01:00Z"); expect(fake.jobs.get(key)?.completed_at).toBe(completed.completedAt); expect(storedStep?.status).toBe("completed"); expect(storedStep?.started_at).toBe("2026-08-13T00:01:00Z"); expect(storedStep?.completed_at).toBe(completed.completedAt); expect(storedStep?.duration_ms).toBe(180_000);
  const stable = { ...doneJob, steps: [{ ...doneJob.steps[0], id: "gh-step-1" }] }; await applyGithubJobSnapshot({ installationId: 5, repository, run: completed, job: stable }); expect(fake.steps.get("org:run-42:job-99:1")?.id).toMatch(/^[0-9a-f-]{36}$/);
});
test("stale completion from an older attempt cannot terminalize a rerun", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  const attempt1Run = { ...run, status: "completed" as const, conclusion: "failure", completedAt: "2026-08-22T10:31:17Z" };
  const attempt1Job = { ...job, id: 900, status: "completed" as const, conclusion: "failure", completedAt: attempt1Run.completedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt1Run, job: attempt1Job });
  const attempt2Run = { ...run, runAttempt: 2, queuedAt: "2026-08-22T10:31:46Z" };
  const attempt2Job = { ...job, id: 97018978327, runAttempt: 2, queuedAt: attempt2Run.queuedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt2Run, job: attempt2Job, authoritative: true });
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt1Run, job: attempt1Job });
  expect(fake.runs.get("org:42")).toMatchObject({ run_attempt: 2, status: "queued", conclusion: null, completed_at: null });
  expect(fake.jobs.get("org:97018978327")).toMatchObject({ run_attempt: 2, status: "queued", conclusion: null, completed_at: null });
});
test("lower-attempt snapshots preserve newer concrete state", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  const newerRun = { ...run, runAttempt: 2, queuedAt: "2026-08-22T10:31:46Z" };
  const newerJob = { ...job, runAttempt: 2, queuedAt: newerRun.queuedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: newerRun, job: newerJob, authoritative: true });
  const olderRun = { ...run, status: "completed" as const, conclusion: "failure", completedAt: "2026-08-22T10:31:17Z" };
  const olderJob = { ...job, status: "completed" as const, conclusion: "failure", completedAt: olderRun.completedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: olderRun, job: olderJob });
  expect(fake.runs.get("org:42")).toMatchObject({ run_attempt: 2, status: "queued", conclusion: null });
  expect(fake.jobs.get("org:99")).toMatchObject({ run_attempt: 2, status: "queued", conclusion: null });
});

test("authoritative same-attempt queued REST state repairs a locally terminal job", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  const completedRun = { ...run, status: "completed" as const, conclusion: "failure", completedAt: "2026-08-22T10:31:17Z" };
  const completedJob = { ...job, status: "completed" as const, conclusion: "failure", completedAt: completedRun.completedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: completedRun, job: completedJob });
  await applyGithubJobSnapshot({ installationId: 5, repository, run, job, authoritative: true });
  expect(fake.runs.get("org:42")).toMatchObject({ status: "queued", conclusion: null, started_at: null, completed_at: null });
  expect(fake.jobs.get("org:99")).toMatchObject({ status: "queued", conclusion: null, started_at: null, completed_at: null });
});

test("a newly queued webhook job reopens an erroneously terminal parent without replaying old jobs", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  await applyGithubJobSnapshot({ installationId: 5, repository, run, job });
  const storedRun = fake.runs.get("org:42")!;
  Object.assign(storedRun, { status: "completed", conclusion: "failure", started_at: queuedAt, completed_at: "2026-08-13T00:04:00Z" });
  const queuedWebhook = (id: number) => applyWorkflowJobWebhook({
    installation: { id: 5 },
    repository: { id: 123, name: "repo", full_name: "acme/repo" },
    action: "queued",
    workflow_job: { id, run_id: 42, run_attempt: 1, run_number: 7, name: "dependent", status: "queued", created_at: queuedAt, labels: ["mars-macos-arm64-2vcpu-10g"] },
  });
  await queuedWebhook(100);
  expect(storedRun).toMatchObject({ status: "in_progress", conclusion: null, completed_at: null });
  expect(fake.jobs.get("org:100")?.status).toBe("queued");
  Object.assign(storedRun, { status: "completed", conclusion: "success", completed_at: "2026-08-13T00:10:00Z" });
  await queuedWebhook(100);
  expect(storedRun).toMatchObject({ status: "completed", conclusion: "success", completed_at: "2026-08-13T00:10:00Z" });
});

test("a completed workflow_job webhook does not terminalize a queued sibling", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  const attempt2Run = { ...run, runAttempt: 2 };
  const sibling = { ...job, id: 1001, runAttempt: 2 };
  const completed = { ...job, id: 1002, runAttempt: 2, status: "completed" as const, conclusion: "success", completedAt: "2026-08-22T10:32:00Z" };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt2Run, job: sibling });
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt2Run, job: { ...completed, status: "queued", conclusion: null, completedAt: null } });
  await applyWorkflowJobWebhook({ installation: { id: 5 }, repository: { id: 123, name: "repo", full_name: "acme/repo" }, sender: { login: "octocat" }, action: "completed", workflow_job: { id: completed.id, run_id: 42, run_attempt: 2, run_number: 7, name: completed.name, status: "completed", conclusion: "success", created_at: completed.queuedAt, completed_at: completed.completedAt, labels: completed.labels, steps: [] } });
  expect(fake.jobs.get("org:1001")?.status).toBe("queued");
  expect(fake.jobs.get("org:1002")?.status).toBe("completed");
});

test("an omitted job does not complete its parent before GitHub reports the run completed", async () => {
  let jobStatus = "queued";
  const database = preparedTestDatabase(name => {
    if (name === "run_lifecycle_mark_job_missing" && jobStatus === "queued") {
      jobStatus = "completed";
      return [{ id: "job-99" }];
    }
    return [];
  });
  expect(await markGithubJobMissing(database, { organizationId: "org", githubJobId: 99, observedAt: queuedAt })).toBe(true);
  expect(jobStatus).toBe("completed");
  expect(await markGithubJobMissing(database, { organizationId: "org", githubJobId: 99, observedAt: queuedAt })).toBe(false);
});
test("step duration is monotonic-compatible for terminal timestamps", () => expect(stageDurationMs({ startedAt: "2026-08-13T00:01:00Z", completedAt: "2026-08-13T00:02:00Z" })).toBe(60_000));
test("strict webhook step validation remains enforced", async () => { await expect(applyWorkflowJobWebhook({ installation: { id: 5 }, repository: { id: 123 }, workflow_job: { id: 99, run_id: 42, status: "queued", steps: [{ number: 0 }] } })).rejects.toThrow("github_payload_invalid"); });

test("does not ingest jobs when the repository is unavailable", async () => {
  const fake = makeStatefulSql();
  fake.repositoryAvailable = false;
  configureRunLifecycle(fake.sql);
  expect(await applyGithubJobSnapshot({ installationId: 5, repository: { id: 123, name: "repo", fullName: "acme/repo" }, run, job })).toBe(false);
  expect(fake.runs.size).toBe(0);
  expect(fake.jobs.size).toBe(0);
});
