import { expect, test } from "bun:test";
import { applyGithubJobSnapshot, applyWorkflowJobWebhook, configureRunLifecycle, markGithubJobMissing, stageDurationMs, type GithubJobSnapshot, type GithubRunSnapshot, type GithubStepSnapshot } from "./runs.ts";
import { runQueuedJobReconciliation } from "./job-reconciler.ts";

type Row = Record<string, unknown>;
function makeStatefulSql() {
  const installations = [{ id: "installation", organization_id: "org" }];
  const repositories = [{ id: "repository" }];
  const runs = new Map<string, Row>();
  const jobs = new Map<string, Row>();
  const steps = new Map<string, Row>();
  const queries: string[] = [];
  const execute = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    queries.push(text);
    if (text.includes("SELECT id,organization_id FROM dashboard_installations")) return installations;
    if (text.includes("SELECT id FROM dashboard_repositories")) return repositories;
    if (text.startsWith("UPDATE dashboard_runs SET status='queued'")) {
      const current = [...runs.values()].find((run) => run.organization_id === values[0] && values.includes(run.github_run_id));
      const requestedAttempt = text.includes("run_attempt") ? values.find((value) => typeof value === "number" && value > 0 && !runs.has(`${values[0]}:${value}`)) : undefined;
      const guardedNonterminal = text.includes("status <> 'completed'");
      const guardedTerminal = text.includes("status='completed'");
      if (current && (requestedAttempt === undefined || current.run_attempt === requestedAttempt) && values.includes("queued") && (!guardedNonterminal || current.status !== "completed") && (!guardedTerminal || current.status === "completed")) {
        Object.assign(current, { status: "queued", conclusion: null, started_at: null, completed_at: null });
      }
      return [];
    }
    if (text.startsWith("UPDATE dashboard_jobs SET status='queued'")) {
      const current = [...jobs.values()].find((job) => job.organization_id === values[0] && values.includes(job.github_job_id));
      const requestedAttempt = text.includes("run_attempt") ? values.find((value) => typeof value === "number" && value > 0 && !jobs.has(`${values[0]}:${value}`)) : undefined;
      const guardedNonterminal = text.includes("status <> 'completed'");
      if (current && (requestedAttempt === undefined || current.run_attempt === requestedAttempt) && (!guardedNonterminal || current.status !== "completed")) Object.assign(current, { status: "queued", conclusion: null, stage: "queued", started_at: null, completed_at: null });
      return [];
    }
    if (text.startsWith("INSERT INTO dashboard_runs")) {
      const attemptQualified = text.includes("run_attempt");
      const key = `${values[0]}:${values[2]}`;
      const runAttempt = attemptQualified ? Number(values[3]) : 1;
      const incoming = {
        organization_id: values[0],
        repository_id: values[1],
        id: `run-${values[2]}`,
        github_run_id: values[2],
        run_attempt: runAttempt,
        status: values[attemptQualified ? 10 : 9],
        conclusion: values[attemptQualified ? 11 : 10],
        queued_at: values[attemptQualified ? 12 : 11],
        started_at: values[attemptQualified ? 13 : 12],
        completed_at: values[attemptQualified ? 14 : 13],
      };
      const current = runs.get(key);
      if (!current) runs.set(key, incoming);
      else if (runAttempt > Number(current.run_attempt)) {
        Object.assign(current, incoming);
      } else if (runAttempt < Number(current.run_attempt) && !text.slice(text.indexOf("status=CASE"), text.indexOf(",conclusion=CASE")).includes("EXCLUDED.run_attempt=dashboard_runs.run_attempt AND")) {
        Object.assign(current, incoming);
      } else if (runAttempt === Number(current.run_attempt)) {
        const authoritativeRepair = text.includes("EXCLUDED.status<>'completed'") && values.includes(true);
        if (authoritativeRepair && incoming.status !== "completed") Object.assign(current, { status: incoming.status, conclusion: incoming.conclusion, queued_at: incoming.queued_at, started_at: incoming.started_at, completed_at: incoming.completed_at });
        else {
          const wasTerminal = current.status === "completed";
          if (!wasTerminal && (incoming.status === "completed" || current.status === "queued" && incoming.status === "in_progress")) current.status = incoming.status;
          current.conclusion ??= incoming.conclusion;
          current.queued_at = [current.queued_at, incoming.queued_at].sort()[0];
          current.started_at = current.started_at && incoming.started_at ? [current.started_at, incoming.started_at].sort()[0] : current.started_at ?? incoming.started_at;
          if (!wasTerminal && (!current.completed_at || incoming.completed_at && String(incoming.completed_at) > String(current.completed_at))) current.completed_at = incoming.completed_at;
        }
      }
      return [runs.get(key)!];
    }
    if (text.startsWith("UPDATE dashboard_jobs SET status='completed'")) {
      const runId = values.find((value) => typeof value === "number" && runs.has(`${values[0]}:${value}`));
      const runRecord = values.find((value) => typeof value === "string" && [...runs.values()].some((run) => run.organization_id === values[0] && run.id === value));
      const runKey = runRecord ?? (runId === undefined ? undefined : `run-${runId}`);
      const scopedAttempt = text.includes("run_attempt") ? values.find((value) => typeof value === "number" && value > 0 && value !== runId && !runs.has(`${values[0]}:${value}`)) : undefined;
      for (const current of jobs.values()) {
        if (current.organization_id !== values[0] || current.run_id !== runKey || scopedAttempt !== undefined && current.run_attempt !== scopedAttempt || current.status === "completed") continue;
        Object.assign(current, { status: "completed", conclusion: current.conclusion ?? values.find((value) => typeof value === "string" && ["success", "failure", "cancelled"].includes(value)) ?? null, completed_at: current.completed_at ?? values.find((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) ?? null });
      }
      return [];
    }
    if (text.startsWith("INSERT INTO dashboard_jobs")) {
      const attemptQualified = text.includes("run_attempt");
      const jobIdIndex = attemptQualified ? 3 : 2;
      const statusIndex = attemptQualified ? 5 : 4;
      const key = `${values[0]}:${values[jobIdIndex]}`;
      const runAttempt = attemptQualified ? Number(values[2]) : 1;
      const incoming = {
        organization_id: values[0],
        run_id: values[1],
        id: `job-${values[jobIdIndex]}`,
        github_job_id: values[jobIdIndex],
        run_attempt: runAttempt,
        name: values[attemptQualified ? 4 : 3],
        status: values[statusIndex],
        conclusion: values[attemptQualified ? 6 : 5],
        stage: values[attemptQualified ? 7 : 6],
        runner_name: values[attemptQualified ? 8 : 7],
        requested_labels: values[attemptQualified ? 9 : 8],
        queued_at: values[attemptQualified ? 10 : 9],
        started_at: values[attemptQualified ? 11 : 10],
        completed_at: values[attemptQualified ? 12 : 11],
      };
      const current = jobs.get(key);
      if (!current) jobs.set(key, incoming);
      else if (runAttempt > Number(current.run_attempt)) {
        Object.assign(current, incoming);
      } else if (runAttempt < Number(current.run_attempt) && !text.slice(text.indexOf("status=CASE"), text.indexOf(",conclusion=CASE")).includes("EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND")) {
        Object.assign(current, incoming);
      } else if (runAttempt === Number(current.run_attempt)) {
        const authoritativeRepair = text.includes("EXCLUDED.status<>'completed'") && values.includes(true);
        if (authoritativeRepair && incoming.status !== "completed") Object.assign(current, { status: incoming.status, conclusion: incoming.conclusion, stage: incoming.stage, queued_at: incoming.queued_at, started_at: incoming.started_at, completed_at: incoming.completed_at });
        else {
          if (current.status !== "completed" && (incoming.status === "completed" || current.status === "queued" && incoming.status === "in_progress")) current.status = incoming.status;
          current.conclusion ??= incoming.conclusion;
          current.runner_name = incoming.runner_name ?? current.runner_name;
          current.queued_at = [current.queued_at, incoming.queued_at].sort()[0];
          current.started_at = current.started_at && incoming.started_at ? [current.started_at, incoming.started_at].sort()[0] : current.started_at ?? incoming.started_at;
          current.completed_at ??= incoming.completed_at;
        }
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
        const preservedStarted = current.started_at && incoming.started_at ? [current.started_at, incoming.started_at].sort()[0] : current.started_at ?? incoming.started_at;
        const preservedCompleted = current.completed_at ?? incoming.completed_at;
        current.duration_ms = Math.max(Number(current.duration_ms ?? 0), Number(incoming.duration_ms ?? 0), preservedStarted && preservedCompleted ? Date.parse(String(preservedCompleted)) - Date.parse(String(preservedStarted)) : 0);
        current.started_at = preservedStarted;
        current.completed_at = preservedCompleted;
      }
      return [steps.get(key)!];
    }
    return [];
  };
  const sql = Object.assign(execute, { begin: async <T>(callback: (tx: typeof execute) => Promise<T>) => callback(execute) });
  return { sql, runs, jobs, steps, queries };
}

const queuedAt = "2026-08-13T00:00:00Z";
const run: GithubRunSnapshot = { id: 42, runAttempt: 1, runNumber: 7, workflowName: "CI", event: "push", branch: "main", commitSha: "abc", actorLogin: "octocat", status: "queued", conclusion: null, queuedAt, startedAt: null, completedAt: null };
const step: GithubStepSnapshot = { id: null, number: 1, name: "build", status: "queued", conclusion: null, queuedAt, startedAt: null, completedAt: null, durationMs: 0 };
const job: GithubJobSnapshot = { id: 99, runId: run.id, runAttempt: 1, name: "macos", status: "queued", conclusion: null, labels: [" self-hosted ", "macOS", "self-hosted"], runnerName: null, queuedAt, startedAt: null, completedAt: null, steps: [step] };

 test("REST and webhook updates execute one monotonic state machine", async () => {
  const fake = makeStatefulSql(); configureRunLifecycle(fake.sql as never);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  expect(await applyGithubJobSnapshot({ installationId: 5, repository, run, job })).toBe(true);
  expect(fake.runs.get("org:42")?.status).toBe("queued");
  expect(await applyWorkflowJobWebhook({ installation: { id: 5 }, repository: { id: 123, name: "repo", full_name: "acme/repo" }, sender: { login: "octocat" }, action: "queued", workflow_job: { id: 99, run_id: 42, run_attempt: 1, run_number: 7, name: "macos", status: "queued", created_at: queuedAt, workflow_name: "CI", head_branch: "main", head_sha: "abc", event: "push", labels: job.labels, steps: [{ number: 1, name: "build", status: "queued" }] } })).toBe(true);
  const key = "org:99"; expect(fake.runs.get("org:42")?.status).toBe("queued"); expect(fake.jobs.get(key)?.status).toBe("queued"); expect(fake.jobs.get(key)?.started_at).toBeNull(); expect(fake.jobs.get(key)?.requested_labels).toEqual(["self-hosted", "macos"]); expect(fake.steps.size).toBe(1);
  expect(fake.queries.find((query) => query.startsWith("INSERT INTO dashboard_jobs"))).toContain("'::jsonb, ::jsonb,");
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
  configureRunLifecycle(fake.sql as never);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  const attempt1Run = { ...run, status: "completed" as const, conclusion: "failure", completedAt: "2026-08-22T10:31:17Z" };
  const attempt1Job = { ...job, id: 900, status: "completed" as const, conclusion: "failure", completedAt: attempt1Run.completedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt1Run, job: attempt1Job });
  const attempt2Run = { ...run, runAttempt: 2, queuedAt: "2026-08-22T10:31:46Z" };
  const attempt2Job = { ...job, id: 97018978327, runAttempt: 2, queuedAt: attempt2Run.queuedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt2Run, job: attempt2Job, authoritative: true });
  await applyGithubJobSnapshot({ installationId: 5, repository, run: attempt1Run, job: attempt1Job });
  expect(fake.runs.get("org:42")).toMatchObject({ run_attempt: 2, status: "queued", conclusion: null, completed_at: null });
  expect(fake.queries.find((query) => query.startsWith("INSERT INTO dashboard_runs"))).toContain("EXCLUDED.run_attempt=dashboard_runs.run_attempt AND (EXCLUDED.status='completed'");
  expect(fake.queries.find((query) => query.startsWith("INSERT INTO dashboard_jobs"))).toContain("EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND (EXCLUDED.status='completed'");
  expect(fake.jobs.get("org:97018978327")).toMatchObject({ run_attempt: 2, status: "queued", conclusion: null, completed_at: null });
});
test("lower-attempt snapshots preserve newer concrete state", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql as never);
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
  configureRunLifecycle(fake.sql as never);
  const repository = { id: 123, name: "repo", fullName: "acme/repo" };
  const completedRun = { ...run, status: "completed" as const, conclusion: "failure", completedAt: "2026-08-22T10:31:17Z" };
  const completedJob = { ...job, status: "completed" as const, conclusion: "failure", completedAt: completedRun.completedAt };
  await applyGithubJobSnapshot({ installationId: 5, repository, run: completedRun, job: completedJob });
  await applyGithubJobSnapshot({ installationId: 5, repository, run, job, authoritative: true });
  expect(fake.runs.get("org:42")).toMatchObject({ status: "queued", conclusion: null, started_at: null, completed_at: null });
  expect(fake.jobs.get("org:99")).toMatchObject({ status: "queued", conclusion: null, started_at: null, completed_at: null });
});

test("a completed workflow_job webhook does not terminalize a queued sibling", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql as never);
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

test("serializes the parent run before checking for remaining nonterminal jobs", async () => {
  const queries: string[] = [];
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    const normalized = text.trimStart();
    queries.push(text);
    if (normalized.includes("UPDATE dashboard_jobs")) return [{ id: "job-99", run_id: "run-42" }];
    if (normalized.includes("SELECT id FROM dashboard_runs")) return [{ id: "run-42" }];
    return [];
  }, { begin: async <T>(callback: (tx: typeof sql) => Promise<T>) => callback(sql) });

  expect(await markGithubJobMissing(sql as never, { organizationId: "org", githubJobId: 99, observedAt: queuedAt })).toBe(true);
  const lockIndex = queries.findIndex((query) => query.trimStart().startsWith("SELECT id FROM dashboard_runs") && query.includes("FOR UPDATE"));
  const parentUpdateIndex = queries.findIndex((query) => query.trimStart().startsWith("UPDATE dashboard_runs"));
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(parentUpdateIndex).toBeGreaterThan(lockIndex);
});
test("step duration is monotonic-compatible for terminal timestamps", () => expect(stageDurationMs({ startedAt: "2026-08-13T00:01:00Z", completedAt: "2026-08-13T00:02:00Z" })).toBe(60_000));
test("strict webhook step validation remains enforced", async () => { await expect(applyWorkflowJobWebhook({ installation: { id: 5 }, repository: { id: 123 }, workflow_job: { id: 99, run_id: 42, status: "queued", steps: [{ number: 0 }] } })).rejects.toThrow("github_payload_invalid"); });

test("webhook ingestion and reconciliation authorize available repositories on active installations", async () => {
  const fake = makeStatefulSql();
  configureRunLifecycle(fake.sql as never);
  await applyGithubJobSnapshot({ installationId: 5, repository: { id: 123, name: "repo", fullName: "acme/repo" }, run, job });
  const ingestionQuery = fake.queries.find((query) => query.includes("SELECT id FROM dashboard_repositories")) ?? "";
  expect(ingestionQuery).toContain("available=true");
  expect(ingestionQuery).not.toContain("approved=true");

  let reconciliationQuery = "";
  const db = (async (strings: TemplateStringsArray) => {
    reconciliationQuery = strings.join(" ");
    return [];
  }) as never;
  await runQueuedJobReconciliation({
    db,
    installationToken: async () => "token",
    githubFetchForInstallation: () => fetch,
    dispatcher: { dispatch: async () => ({}) } as never,
    repositoryFullName: "acme/repo",
  });
  expect(reconciliationQuery).toContain("repo.available=true");
  expect(reconciliationQuery).toContain("repo.full_name=");
  expect(reconciliationQuery).toContain("ORDER BY j.queued_at ASC, j.github_job_id ASC");
  expect(reconciliationQuery).toContain("i.state='approved'");
  expect(reconciliationQuery).toContain("AND NOT EXISTS (");
  expect(reconciliationQuery).toContain("l.github_job_id=j.github_job_id");
  expect(reconciliationQuery).toContain("l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')");
  expect(reconciliationQuery).not.toContain("repo.approved");
});
