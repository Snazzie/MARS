import { expect, test } from "bun:test";
import { createDb, schema, type DatabaseClient } from "@mars/db";
import { eq } from "drizzle-orm";
import { SecretBox } from "./auth.ts";
import { applyGithubJobSnapshot, applyWorkflowJobWebhook, configureRunLifecycle, type GithubRunSnapshot, type GithubJobSnapshot } from "./runs.ts";
import { enqueuePipelineFailureAnalysis, processPipelineFailureAnalyses, type PipelineFailureAnalysisDeps } from "./pipeline-failure-analysis.ts";

const integration = Bun.env.MARS_E2E_DATABASE_URL ? test : test.skip;
const org = "10000000-0000-4000-8000-000000000001";
const repo = "20000000-0000-4000-8000-000000000001";
const installation = "30000000-0000-4000-8000-000000000001";
const provider = "40000000-0000-4000-8000-000000000001";
const run: GithubRunSnapshot = { id: 812, runAttempt: 1, runNumber: 7, workflowName: "ci", event: "push", branch: "main", commitSha: "abcdef1234567", actorLogin: "mars", status: "completed", conclusion: "failure", queuedAt: "2026-10-07T00:00:00.000Z", startedAt: "2026-10-07T00:01:00.000Z", completedAt: "2026-10-07T00:02:00.000Z" };
const failedJob = (id = 9001): GithubJobSnapshot => ({ id, runId: run.id, runAttempt: 1, name: `test-${id}`, status: "completed", conclusion: "failure", labels: [], runnerName: null, queuedAt: run.queuedAt, startedAt: run.startedAt, completedAt: run.completedAt, steps: [] });

async function fixture(work: (db: DatabaseClient) => Promise<void>) {
  const db = createDb(Bun.env.MARS_E2E_DATABASE_URL!);
  try {
    await db.transaction(async tx => {
      // Connection-local copies preserve PostgreSQL constraints without touching application data.
      for (const table of ["dashboard_installations", "dashboard_repositories", "dashboard_runs", "dashboard_jobs", "dashboard_job_steps", "dashboard_step_log_chunks", "dashboard_log_chunks", "llm_providers", "repository_failure_analysis_settings", "pipeline_failure_analyses", "pipeline_analysis_comments"]) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES INCLUDING CONSTRAINTS) ON COMMIT DROP`);
      }
      await tx.insert(schema.dashboardInstallations).values({ id: installation, organizationId: org, githubInstallationId: 1, state: "approved" });
      await tx.insert(schema.dashboardRepositories).values({ id: repo, organizationId: org, installationId: installation, githubRepositoryId: 8, name: "repo", fullName: "acme/repo", available: true });
      await tx.insert(schema.llmProviders).values({ id: provider, name: "local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "model" });
      await tx.insert(schema.repositoryFailureAnalysisSettings).values({ organizationId: org, repositoryId: repo, providerId: provider, enabled: true, enabledSince: "2026-10-06T00:00:00.000Z" });
      configureRunLifecycle(tx);
      await work(tx);
    });
  } finally { await db.$client.end({ timeout: 1 }); }
}

function worker(db: DatabaseClient, calls: number[]): PipelineFailureAnalysisDeps {
  return {
    db, secretBox: new SecretBox(Buffer.alloc(32, 5).toString("base64")), githubAppId: 1,
    installationToken: async () => "installation-token",
    githubFetchForInstallation: () => (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/logs")) return new Response("AssertionError: expected 2 but got 3\n");
      if (path.includes("/actions/jobs/")) return Response.json({ id: Number(path.split("/").at(-1)), run_id: 812, run_attempt: 1, status: "completed", conclusion: "failure", steps: [] });
      if (path.endsWith("/actions/runs/812")) return Response.json({ pull_requests: [] });
      if (path.endsWith("/actions/runs")) {
        const runs = await db.select().from(schema.dashboardRuns);
        return Response.json({ total_count: runs.length, workflow_runs: runs.map(row => ({ id: row.githubRunId, run_attempt: row.runAttempt, run_number: row.runNumber, name: row.workflowName, head_branch: row.branch, created_at: run.queuedAt })) });
      }
      throw new Error(`unexpected GitHub call ${path}`);
    }) as typeof fetch,
    generatePipelineAnalysis: async ({ context }) => { calls.push(...context.failedJobs.map(job => job.jobId)); return { summary: "Assertion failed", failures: context.failedJobs.map(job => ({ jobId: job.jobId, stepNumber: null, explanation: "Assertion mismatch", evidence: ["expected 2 but got 3"], suggestedFix: "Check expected value" })) }; },
  };
}

integration("failed job webhook queues once, waits for the complete run, and analyzes all failed jobs once", () => fixture(async db => {
  const event = { action: "completed", installation: { id: 1 }, repository: { id: 8, name: "repo", full_name: "acme/repo" }, workflow_job: { id: 9001, run_id: 812, run_attempt: 1, run_number: 7, workflow_name: "ci", head_branch: "main", head_sha: run.commitSha, status: "completed", conclusion: "failure", created_at: run.queuedAt, completed_at: run.completedAt, steps: [] } };
  await applyWorkflowJobWebhook(event);
  await applyWorkflowJobWebhook(event);
  const queued = await db.select().from(schema.pipelineFailureAnalyses);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ state: "pending", source: { ready: false } });
  const calls: number[] = [];
  await processPipelineFailureAnalyses(worker(db, calls));
  expect(calls).toEqual([]);
  await applyGithubJobSnapshot({ installationId: 1, repository: { id: 8, name: "repo", fullName: "acme/repo" }, run, job: failedJob(), authoritative: true });
  await enqueuePipelineFailureAnalysis({ db, organizationId: org, repositoryId: repo, run, jobs: [failedJob(), failedJob(9002)] });
  await processPipelineFailureAnalyses(worker(db, calls));
  await processPipelineFailureAnalyses(worker(db, calls));
  expect(calls).toEqual([9001, 9002]);
  expect((await db.select().from(schema.pipelineFailureAnalyses))[0]).toMatchObject({ state: "completed", result: { summary: "Assertion failed" } });
}));

integration.each([
  { name: "new run on the same workflow and branch", newer: { ...run, id: 813, runNumber: 8 }, skipped: true },
  { name: "new attempt of the same run", newer: { ...run, runAttempt: 2 }, skipped: true },
  { name: "another workflow", newer: { ...run, id: 813, runNumber: 8, workflowName: "deploy" }, skipped: false },
  { name: "another branch", newer: { ...run, id: 813, runNumber: 8, branch: "other" }, skipped: false },
])("queued analysis handles $name without obsolete model calls", ({ newer, skipped }) => fixture(async db => {
  await applyGithubJobSnapshot({ installationId: 1, repository: { id: 8, name: "repo", fullName: "acme/repo" }, run, job: failedJob(), authoritative: true });
  await enqueuePipelineFailureAnalysis({ db, organizationId: org, repositoryId: repo, run, jobs: [failedJob()] });
  if (newer.id === run.id) await db.update(schema.dashboardRuns).set({ runAttempt: 2, status: "queued", conclusion: null }).where(eq(schema.dashboardRuns.githubRunId, run.id));
  else await db.insert(schema.dashboardRuns).values({ ...newer, id: undefined, organizationId: org, repositoryId: repo, githubRunId: newer.id, status: "queued", conclusion: null });
  const calls: number[] = [];
  await processPipelineFailureAnalyses(worker(db, calls));
  const [analysis] = await db.select().from(schema.pipelineFailureAnalyses);
  if (skipped) { expect(calls).toEqual([]); expect(analysis).toMatchObject({ state: "skipped", errorCode: "analysis_superseded" }); }
  else { expect(calls).toEqual([9001]); expect(analysis.state).toBe("completed"); }
}));

integration("a later run arriving during generation prevents publication and discards obsolete suggestions", () => fixture(async db => {
  await applyGithubJobSnapshot({ installationId: 1, repository: { id: 8, name: "repo", fullName: "acme/repo" }, run, job: failedJob(), authoritative: true });
  await enqueuePipelineFailureAnalysis({ db, organizationId: org, repositoryId: repo, run, jobs: [failedJob()] });
  const deps = worker(db, []);
  const generate = deps.generatePipelineAnalysis;
  deps.generatePipelineAnalysis = async input => {
    const result = await generate(input);
    await db.insert(schema.dashboardRuns).values({ ...run, id: undefined, organizationId: org, repositoryId: repo, githubRunId: 813, runNumber: 8, status: "queued", conclusion: null });
    return result;
  };
  await processPipelineFailureAnalyses(deps);
  expect((await db.select().from(schema.pipelineFailureAnalyses))[0]).toMatchObject({ state: "skipped", errorCode: "analysis_superseded", result: null });
  expect(await db.select().from(schema.pipelineAnalysisComments)).toEqual([]);
}));

integration("a newer GitHub run not yet discovered locally cancels the queued analysis", () => fixture(async db => {
  await applyGithubJobSnapshot({ installationId: 1, repository: { id: 8, name: "repo", fullName: "acme/repo" }, run, job: failedJob(), authoritative: true });
  await enqueuePipelineFailureAnalysis({ db, organizationId: org, repositoryId: repo, run, jobs: [failedJob()] });
  const calls: number[] = [];
  const deps = worker(db, calls);
  deps.githubFetchForInstallation = () => (async (_input: RequestInfo | URL) => Response.json({ total_count: 1, workflow_runs: [{ id: 813, run_attempt: 1, run_number: 8, name: "ci", head_branch: "main", created_at: "2026-10-07T01:00:00.000Z" }] })) as typeof fetch;
  await processPipelineFailureAnalyses(deps);
  expect(calls).toEqual([]);
  expect((await db.select().from(schema.pipelineFailureAnalyses))[0]).toMatchObject({ state: "skipped", errorCode: "analysis_superseded" });
}));

integration("a newer run during comment lookup prevents posting obsolete PR feedback", () => fixture(async db => {
  await applyGithubJobSnapshot({ installationId: 1, repository: { id: 8, name: "repo", fullName: "acme/repo" }, run, job: failedJob(), authoritative: true });
  await enqueuePipelineFailureAnalysis({ db, organizationId: org, repositoryId: repo, run, jobs: [failedJob()] });
  const deps = worker(db, []);
  const github = deps.githubFetchForInstallation(1);
  let posts = 0;
  deps.githubFetchForInstallation = () => (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/actions/runs/812")) return Response.json({ pull_requests: [{ number: 3, base: { repo: { id: 8 } } }] });
    if (path.endsWith("/issues/3/comments")) {
      if (init?.method === "POST") { posts++; return Response.json({ id: 1, html_url: "https://github.com/acme/repo/issues/3#issuecomment-1" }); }
      await db.insert(schema.dashboardRuns).values({ ...run, id: undefined, organizationId: org, repositoryId: repo, githubRunId: 813, runNumber: 8, status: "queued", conclusion: null });
      return Response.json([]);
    }
    return github(input, init);
  }) as typeof fetch;
  await processPipelineFailureAnalyses(deps);
  expect(posts).toBe(0);
  expect((await db.select().from(schema.pipelineAnalysisComments))[0]).toMatchObject({ state: "failed", errorCode: "analysis_superseded", commentId: null });
}));
