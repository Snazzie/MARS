import { expect, test } from "bun:test";
import { createDb, getAllOverview, getOverview } from "./index.ts";
import { getRunDetail, listPipelineAnalysisWork, listPrReviewWork } from "./dashboard.ts";

const databaseUrl = Bun.env.MARS_E2E_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration("aggregate overview binds nullable organization scope and excludes nonmember jobs", async () => {
  const db = createDb(databaseUrl!);
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
  const userId = "20000000-0000-4000-8000-000000000001";
  try {
    await db.transaction(async tx => {
      // Copy column types, not application data or foreign keys, into connection-local tables.
      for (const table of ["dashboard_jobs", "dashboard_runs", "dashboard_repositories", "dashboard_installations", "memberships", "runner_leases", "runner_pools", "workers", "dashboard_job_resource_samples", "dashboard_job_timing_snapshots"]) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
      }
      await tx.$client.unsafe("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member')", [organizationId, userId]);
      await tx.$client.unsafe(`
        INSERT INTO dashboard_jobs (organization_id, run_id, github_job_id, name, status, stage, requested, requested_labels, queued_at, started_at) VALUES
          ($1, gen_random_uuid(), 1, 'member running', 'in_progress', 'running', '{}', '["windows-latest"]', now() - interval '3 hours', now() - interval '2 hours'),
          ($1, gen_random_uuid(), 2, 'member queued', 'queued', 'queued', '{}', '["ubuntu-latest"]', now() - interval '3 hours', NULL),
          ($2, gen_random_uuid(), 3, 'nonmember running', 'in_progress', 'running', '{}', '["windows-latest"]', now() - interval '3 hours', now() - interval '2 hours'),
          ($2, gen_random_uuid(), 4, 'nonmember queued', 'queued', 'queued', '{}', '["ubuntu-latest"]', now() - interval '3 hours', NULL);
      `, [organizationId, otherOrganizationId]);

      for (const period of ["24h", "7d", "30d"] as const) {
        const aggregate = await getAllOverview(tx, userId, period);
        const organization = await getOverview(tx, organizationId, period);
        expect(aggregate.organizationId).toBe("all");
        expect(aggregate.timeseries).toEqual(organization.timeseries);
        expect(aggregate.timeseries?.at(-1)).toMatchObject({ pending: 1, running: 1 });
        expect(aggregate.jobOutcomes).toEqual(organization.jobOutcomes);
        expect(aggregate.jobOutcomes).toContainEqual({ outcome: "running", platforms: { macos: 0, ubuntu: 0, windows: 1, other: 0 } });
        expect(aggregate.jobOutcomes).toContainEqual({ outcome: "queued", platforms: { macos: 0, ubuntu: 1, windows: 0, other: 0 } });
        expect(aggregate).toMatchObject({ queueP50Ms: 3_600_000, queueP95Ms: 3_600_000, durationP50Ms: 0, durationP95Ms: 0 });
        expect(organization).toMatchObject({ queueP50Ms: 3_600_000, queueP95Ms: 3_600_000, durationP50Ms: 0, durationP95Ms: 0 });
      }
      const nonmember = await getAllOverview(tx, "20000000-0000-4000-8000-000000000002", "24h");
      expect(nonmember.timeseries?.every(point => point.pending === 0 && point.running === 0)).toBe(true);
      expect(nonmember.jobOutcomes?.every(outcome => Object.values(outcome.platforms).every(count => count === 0))).toBe(true);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});

integration("overview percentiles use valid observed timings within the reporting period and membership scope", async () => {
  const db = createDb(databaseUrl!);
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
  const userId = "20000000-0000-4000-8000-000000000001";
  const metrics = (overview: Awaited<ReturnType<typeof getOverview>>) => ({
    queueP50Ms: overview.queueP50Ms, queueP95Ms: overview.queueP95Ms,
    durationP50Ms: overview.durationP50Ms, durationP95Ms: overview.durationP95Ms,
  });
  try {
    await db.transaction(async tx => {
      for (const table of ["dashboard_jobs", "dashboard_runs", "dashboard_repositories", "dashboard_installations", "memberships", "runner_leases", "runner_pools", "workers", "dashboard_job_resource_samples", "dashboard_job_timing_snapshots"]) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
      }
      await tx.$client.unsafe("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member')", [organizationId, userId]);
      await tx.$client.unsafe(`
        INSERT INTO dashboard_jobs (organization_id, run_id, github_job_id, name, status, stage, requested, queued_at, started_at, completed_at) VALUES
          ($1, gen_random_uuid(), 1, 'fast', 'completed', 'completed', '{}', now() - interval '2 hours 10 seconds', now() - interval '2 hours', now() - interval '1 hour 59 minutes'),
          ($1, gen_random_uuid(), 2, 'slow failed', 'completed', 'completed', '{}', now() - interval '3 hours 30 seconds', now() - interval '3 hours', now() - interval '2 hours 57 minutes'),
          ($1, gen_random_uuid(), 3, 'queued', 'queued', 'queued', '{}', now() - interval '1 hour', NULL, NULL),
          ($1, gen_random_uuid(), 4, 'missing start', 'completed', 'completed', '{}', now() - interval '1 hour', NULL, now()),
          ($1, gen_random_uuid(), 5, 'invalid chronology', 'completed', 'completed', '{}', now(), now() - interval '1 second', now() - interval '2 seconds'),
          ($1, gen_random_uuid(), 6, 'previous week', 'completed', 'completed', '{}', now() - interval '2 days 50 seconds', now() - interval '2 days', now() - interval '2 days' + interval '5 minutes'),
          ($1, gen_random_uuid(), 7, 'previous month', 'completed', 'completed', '{}', now() - interval '10 days 70 seconds', now() - interval '10 days', now() - interval '10 days' + interval '7 minutes'),
          ($1, gen_random_uuid(), 8, 'expired', 'completed', 'completed', '{}', now() - interval '40 days 1 hour', now() - interval '40 days', now() - interval '39 days'),
          ($2, gen_random_uuid(), 9, 'nonmember', 'completed', 'completed', '{}', now() - interval '10 hours', now() - interval '5 hours', now());
      `, [organizationId, otherOrganizationId]);
      await tx.$client.unsafe("UPDATE dashboard_jobs SET conclusion = CASE WHEN github_job_id = 2 THEN 'failure' ELSE 'success' END WHERE status = 'completed'");
      const expected = {
        "24h": { queueP50Ms: 20_000, queueP95Ms: 29_000, durationP50Ms: 120_000, durationP95Ms: 174_000 },
        "7d": { queueP50Ms: 30_000, queueP95Ms: 48_000, durationP50Ms: 180_000, durationP95Ms: 288_000 },
        "30d": { queueP50Ms: 40_000, queueP95Ms: 67_000, durationP50Ms: 240_000, durationP95Ms: 402_000 },
      };
      for (const period of ["24h", "7d", "30d"] as const) {
        const organization = await getOverview(tx, organizationId, period);
        const aggregate = await getAllOverview(tx, userId, period);
        expect(metrics(organization)).toEqual(expected[period]);
        expect(metrics(aggregate)).toEqual(expected[period]);
        expect(aggregate.timeToStart).toEqual(organization.timeToStart);
        expect(organization.timeToStart.reduce((sum, point) => sum + point.sampleCount, 0)).toBe(period === "24h" ? 2 : period === "7d" ? 3 : 4);
        expect(organization.timeToStart.filter(point => point.sampleCount === 0).every(point => point.p50Ms === null && point.p95Ms === null)).toBe(true);
        if (period === "24h") {
          expect(organization.timeToStart.filter(point => point.sampleCount > 0).map(({ sampleCount, p50Ms, p95Ms }) => ({ sampleCount, p50Ms, p95Ms }))).toEqual([
            { sampleCount: 1, p50Ms: 30_000, p95Ms: 30_000 },
            { sampleCount: 1, p50Ms: 10_000, p95Ms: 10_000 },
          ]);
        }
      }
      const empty = { queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0 };
      expect(metrics(await getOverview(tx, "10000000-0000-4000-8000-000000000003", "24h"))).toEqual(empty);
      expect(metrics(await getAllOverview(tx, "20000000-0000-4000-8000-000000000002", "24h"))).toEqual(empty);
      const nonmember = await getAllOverview(tx, "20000000-0000-4000-8000-000000000002", "24h");
      expect(nonmember.timeToStart.every(point => point.sampleCount === 0 && point.p50Ms === null && point.p95Ms === null)).toBe(true);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});

integration("AI work queue preserves attempt identity, paginates tied enqueue times, and excludes terminal and nonmember work", async () => {
  const db = createDb(databaseUrl!);
  const org = "10000000-0000-4000-8000-000000000001", otherOrg = "10000000-0000-4000-8000-000000000002";
  const user = "20000000-0000-4000-8000-000000000001";
  const run = "30000000-0000-4000-8000-000000000001", otherRun = "30000000-0000-4000-8000-000000000002";
  const repo = "40000000-0000-4000-8000-000000000001", otherRepo = "40000000-0000-4000-8000-000000000002";
  const queued = "50000000-0000-4000-8000-000000000001", running = "50000000-0000-4000-8000-000000000002";
  try {
    await db.transaction(async tx => {
      for (const table of ["memberships", "dashboard_repositories", "dashboard_runs", "pipeline_failure_analyses", "dashboard_jobs", "dashboard_job_steps", "dashboard_action_edges", "dashboard_run_stages", "runner_leases", "runner_pools", "pipeline_analysis_comments", "repository_failure_analysis_settings", "global_failure_analysis_settings"]) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
      }
      await tx.$client.unsafe("INSERT INTO memberships (organization_id,user_id,role) VALUES ($1,$2,'member')", [org, user]);
      for (const [organizationId, repositoryId, runId] of [[org, repo, run], [otherOrg, otherRepo, otherRun]]) {
        await tx.$client.unsafe("INSERT INTO dashboard_repositories (id,organization_id,installation_id,github_repository_id,name,full_name) VALUES ($1,$2,gen_random_uuid(),1,'project','acme/project')", [repositoryId, organizationId]);
        await tx.$client.unsafe("INSERT INTO dashboard_runs (id,organization_id,repository_id,github_run_id,run_number,run_attempt,workflow_name,event,branch,commit_sha,actor_login,status,queued_at,conclusion) VALUES ($1,$2,$3,1,99,6,'Renamed CI','push','main','abcdef123','actor','completed',now(),'failure')", [runId, organizationId, repositoryId]);
      }
      const insert = async (id: string, state: string, attempt: number, organizationId = org, repositoryId = repo, runId = run) => {
        await tx.$client.unsafe("INSERT INTO pipeline_failure_analyses (id,organization_id,repository_id,run_id,github_run_id,run_attempt,provider_kind,provider_name,model,source,state,created_at,started_at) VALUES ($1,$2,$3,$4,1,$7,'openai-compatible','Local model','model-id',$5::jsonb,$6,'2026-10-09T00:00:00Z',CASE WHEN $6='running' THEN '2026-10-09T00:00:05Z'::timestamptz END)", [id, organizationId, repositoryId, runId, JSON.stringify({ run: { number: 42, workflowName: "Captured CI" } }), state, attempt]);
      };
      await insert(queued, "pending", 5);
      await insert(running, "running", 6);
      const completed = "50000000-0000-4000-8000-000000000003", failed = "50000000-0000-4000-8000-000000000004", skipped = "50000000-0000-4000-8000-000000000005";
      await insert(completed, "completed", 1);
      await insert(failed, "failed", 2);
      await insert(skipped, "skipped", 3);
      await insert(crypto.randomUUID(), "pending", 1, otherOrg, otherRepo, otherRun);
      await insert(crypto.randomUUID(), "completed", 2, otherOrg, otherRepo, otherRun);
      const result = { summary: "Attempt one result", failures: [] };
      await tx.$client.unsafe("UPDATE pipeline_failure_analyses SET result=$2::jsonb WHERE id=$1", [completed, JSON.stringify(result)]);
      await tx.$client.unsafe("INSERT INTO pipeline_analysis_comments (analysis_id,pr_number,state,comment_url,comment_body) VALUES ($1,42,'published','https://github.com/acme/project/pull/42#issuecomment-7','Exact posted text')", [completed]);
      await tx.$client.unsafe("UPDATE pipeline_failure_analyses SET started_at='2026-10-09T00:00:05Z', finished_at='2026-10-09T00:00:25Z', provider_called_at='2026-10-09T00:00:08Z', input_tokens=1200, output_tokens=400, input_usd_per_million_tokens=2, output_usd_per_million_tokens=10 WHERE id=$1", [completed]);
      const first = await listPipelineAnalysisWork(tx, { userId: user }, 1);
      expect(first.nextCursor).toBe(queued);
      expect(first.items).toMatchObject([{
        id: queued, organizationId: org, repositoryId: repo, repositoryName: "acme/project", runId: run,
        runNumber: 42, runAttempt: 5, workflowName: "Captured CI", state: "pending", providerName: "Local model", model: "model-id", errorCode: null,
        metrics: { queuedAt: "2026-10-09T00:00:00.000Z", startedAt: null, finishedAt: null, providerCalledAt: null, durationMs: null, usage: { input: null, output: null, total: null }, estimatedCostUsd: null },
      }]);
      const second = await listPipelineAnalysisWork(tx, { userId: user }, 1, first.nextCursor);
      expect(second.items.map(item => [item.id, item.state, item.metrics.startedAt])).toEqual([[running, "running", "2026-10-09T00:00:05.000Z"]]);
      expect(second.nextCursor).toBeNull();
      expect((await listPipelineAnalysisWork(tx, { organizationId: org })).items.map(item => item.id)).toEqual([queued, running]);
      expect((await listPipelineAnalysisWork(tx, { userId: crypto.randomUUID() })).items).toEqual([]);
      const history = await listPipelineAnalysisWork(tx, { userId: user }, 2, null, "history");
      expect(history.items.map(item => [item.id, item.state, item.runAttempt])).toEqual([[skipped, "skipped", 3], [failed, "failed", 2]]);
      expect(history.nextCursor).toBe(failed);
      const older = await listPipelineAnalysisWork(tx, { userId: user }, 2, history.nextCursor, "history");
      expect(older.nextCursor).toBeNull();
      expect(older.items.map(item => item.id)).toEqual([completed]);
      expect(older.items[0]!.metrics).toMatchObject({
        queuedAt: "2026-10-09T00:00:00.000Z", startedAt: "2026-10-09T00:00:05.000Z", finishedAt: "2026-10-09T00:00:25.000Z",
        providerCalledAt: "2026-10-09T00:00:08.000Z", queueWaitMs: 5000, durationMs: 20_000,
        usage: { input: 1200, output: 400, total: 1600 },
      });
      expect(older.items[0]!.metrics.estimatedCostUsd).toBeCloseTo(0.0064, 10);
      expect(older.items[0]!.result).toEqual(result);
      expect(older.items[0]!.comments).toMatchObject([{ prNumber: 42, state: "published", commentUrl: "https://github.com/acme/project/pull/42#issuecomment-7", commentBody: "Exact posted text" }]);
      expect((await listPipelineAnalysisWork(tx, { userId: crypto.randomUUID() }, 50, null, "history")).items).toEqual([]);
      // Current run is attempt 6: its metrics must not come from completed attempt 1.
      expect((await getRunDetail(tx, org, run))?.failureAnalysis?.runAttempt).toBe(6);
      expect((await getRunDetail(tx, org, run))?.failureAnalysis?.metrics.usage.total).toBeNull();
      await tx.$client.unsafe("UPDATE dashboard_runs SET run_attempt=1 WHERE id=$1", [run]);
      expect((await getRunDetail(tx, org, run))?.failureAnalysis?.metrics).toEqual(older.items[0]!.metrics);
      expect((await getRunDetail(tx, org, run))?.failureAnalysis).toMatchObject({ runAttempt: 1, result, comments: [{ commentBody: "Exact posted text" }] });
      await tx.$client.unsafe("UPDATE pipeline_failure_analyses SET state='completed' WHERE id=$1", [queued]);
      expect((await listPipelineAnalysisWork(tx, { userId: user })).items.map(item => item.id)).toEqual([running]);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});

integration("PR review work paginates and scopes workspace membership", async () => {
  const db = createDb(databaseUrl!);
  const org = "10000000-0000-4000-8000-000000000001";
  const repo = "30000000-0000-4000-8000-000000000001";
  const member = "20000000-0000-4000-8000-000000000001";
  try {
    await db.transaction(async tx => {
      for (const table of ["pr_reviews", "dashboard_repositories", "memberships"]) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
      }
      await tx.$client.unsafe("INSERT INTO dashboard_repositories (id, organization_id, installation_id, github_repository_id, name, full_name) VALUES ($1,$2,$3,1,'repo','acme/repo')", [repo, org, crypto.randomUUID()]);
      await tx.$client.unsafe("INSERT INTO memberships (organization_id,user_id,role) VALUES ($1,$2,'member')", [org, member]);
      const ids = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"];
      for (const [index, id] of ids.entries()) await tx.$client.unsafe("INSERT INTO pr_reviews (id,organization_id,repository_id,pr_number,base_sha,head_sha,trigger,provider_snapshot,source,settings_updated_at,analysis_state,publication_state,created_at,started_at,completed_at,input_tokens,output_tokens,estimated_cost_usd,provider_called_at) VALUES ($1,$2,$3,$4,'base','head','review_command',$5::jsonb,'{}'::jsonb,'2026-10-09T00:00:00Z',$6,'pending',$7,$8,$9,100,20,0.25,$8)", [id, org, repo, 40 + index, JSON.stringify({ name: "Provider", model: "model-x", kind: "openai-compatible" }), index === 0 ? "pending" : "completed", index === 0 ? "2026-10-09T00:00:00Z" : "2026-10-08T00:00:00Z", index === 0 ? null : "2026-10-08T00:00:10Z", index === 0 ? null : "2026-10-08T00:00:20Z"]);
      const secondQueuedId = "40000000-0000-4000-8000-000000000003";
      await tx.$client.unsafe("INSERT INTO pr_reviews (id,organization_id,repository_id,pr_number,base_sha,head_sha,trigger,provider_snapshot,source,settings_updated_at,analysis_state,publication_state,created_at) SELECT $1,organization_id,repository_id,42,base_sha,head_sha,trigger,provider_snapshot,source,settings_updated_at,'pending','pending',created_at + interval '1 second' FROM pr_reviews WHERE id=$2", [secondQueuedId, ids[0]]);
      const queued = await listPrReviewWork(tx, { userId: member }, 1);
      expect(queued.items[0]).toMatchObject({ id: ids[0], repositoryName: "acme/repo", prNumber: 40, providerName: "Provider", model: "model-x", analysisState: "pending" });
      expect(queued.nextCursor).toBe(ids[0]);
      const nextQueued = await listPrReviewWork(tx, { userId: member }, 1, queued.nextCursor);
      expect(nextQueued.items.map(item => item.id)).toEqual([secondQueuedId]);
      expect(nextQueued.nextCursor).toBeNull();
      const history = await listPrReviewWork(tx, { organizationId: org }, 1, null, "history");
      expect(history.items[0]).toMatchObject({ id: ids[1], analysisState: "completed", metrics: { usage: { input: 100, output: 20 }, estimatedCostUsd: 0.25 } });
      expect((await listPrReviewWork(tx, { userId: crypto.randomUUID() })).items).toEqual([]);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});
