import type { DatabaseClient } from "./index.ts";
import { CapacitySnapshot, ConnectionState, ConfigurationState, PoolSummary, RuntimeDriverName, RuntimePlatform, RuntimeTerminationEvidence, WorkerContainerStatus, WorkerDoctor, WorkerDisconnectEvidence, WorkerLimits, WorkerState, GuestPlatform, WorkerCacheSummary, WorkerHealth } from "@mars/contracts";
import type { ActionGraph, CursorPage, LogChunk, OrganizationSummary, OverviewDto, OverviewTimeseriesPoint, PipelineFailureAnalysis, RepositorySummary, RunDetail, RunJob, RunStage, RunStageRecord, RunSummary, WorkerDetail } from "@mars/contracts";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { getGithubRunnerCostSavings } from "./github-runner-cost.ts";
import type { AiTokenUsage } from "@mars/contracts";
import { aggregateAiTokenUsage, getPipelineAnalysisMetrics, type PipelineFailureAnalysisUsageRow } from "./ai-token-usage.ts";
import type { PipelineAnalysisWork } from "@mars/contracts";
export type DashboardDb = DatabaseClient;
export type RunTransition = { status: RunSummary["status"]; conclusion: RunSummary["conclusion"]; startedAt?: string | null; completedAt?: string | null };
const aiTokenUsageQueries = defineQueries(db => ({
  rows: db.select({
    calledAt: schema.pipelineFailureAnalyses.providerCalledAt,
    inputTokens: schema.pipelineFailureAnalyses.inputTokens,
    outputTokens: schema.pipelineFailureAnalyses.outputTokens,
    inputUsdPerMillionTokens: schema.pipelineFailureAnalyses.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: schema.pipelineFailureAnalyses.outputUsdPerMillionTokens,
  }).from(schema.pipelineFailureAnalyses)
    .where(sql`${schema.pipelineFailureAnalyses.providerCalledAt} >= (${sql.placeholder("from")}::date::timestamp AT TIME ZONE 'UTC') AND ${schema.pipelineFailureAnalyses.providerCalledAt} < ((${sql.placeholder("to")}::date + 1)::timestamp AT TIME ZONE 'UTC')`)
    .prepare("dashboard_ai_token_usage"),
}));

export async function getAiTokenUsage(db: DashboardDb, now = new Date()): Promise<AiTokenUsage> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 29);
  const queryArgs = { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
  const [pipelineRows, prRows] = await Promise.all([
    aiTokenUsageQueries(db).rows.execute(queryArgs),
    prReviewUsageQueries(db).rows.execute(queryArgs),
  ]);
  const prUsageRows: PipelineFailureAnalysisUsageRow[] = (prRows ?? []).map(row => ({
    calledAt: row.calledAt,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    inputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: null,
    estimatedCostUsd: row.estimatedCostUsd,
  }));
  return aggregateAiTokenUsage([...(pipelineRows ?? []) as PipelineFailureAnalysisUsageRow[], ...prUsageRows], now);
}

const prReviewUsageQueries = defineQueries(db => ({
  rows: db.select({
    calledAt: schema.prReviews.providerCalledAt,
    inputTokens: schema.prReviews.inputTokens,
    outputTokens: schema.prReviews.outputTokens,
    estimatedCostUsd: schema.prReviews.estimatedCostUsd,
  }).from(schema.prReviews)
    .where(sql`${schema.prReviews.providerCalledAt} >= (${sql.placeholder("from")}::date::timestamp AT TIME ZONE 'UTC') AND ${schema.prReviews.providerCalledAt} < ((${sql.placeholder("to")}::date + 1)::timestamp AT TIME ZONE 'UTC')`)
    .prepare("dashboard_pr_review_usage"),
}));

const statusOrder: Record<RunSummary["status"], number> = { queued: 0, in_progress: 1, completed: 2 };
const terminalConclusions = new Set(["success", "failure", "cancelled", "skipped", "neutral"]);
export function monotonicTransition(current: RunTransition, next: RunTransition): RunTransition {
  if (current.status === "completed" || terminalConclusions.has(current.conclusion ?? "")) return current;
  if (statusOrder[next.status] < statusOrder[current.status]) return current;
  return { ...current, ...next };
}
export function boundedLogChunks(chunks: LogChunk[], limit: number): { items: LogChunk[]; hasMore: boolean } {
  const safeLimit = Math.max(0, Math.min(1000, Math.floor(limit)));
  return { items: chunks.slice(0, safeLimit).map(chunk => ({ ...chunk, content: chunk.content.slice(0, 256 * 1024) })), hasMore: chunks.length > safeLimit };
}
export function cursorBoundary<T extends { id: string }>(items: T[], cursor: string | null, limit: number): CursorPage<T> {
  const start = cursor ? Math.max(0, items.findIndex(item => item.id === cursor) + 1) : 0;
  const page = items.slice(start, start + Math.max(0, limit));
  return { items: page, nextCursor: start + page.length < items.length && page.length ? page.at(-1)!.id : null };
}

const organizationQueries = defineQueries((db) => ({
  list: db.select({
    id: schema.organizations.id,
    name: schema.organizations.login,
    login: schema.organizations.login,
    role: schema.memberships.role,
    repositoryCount: sql<number>`(SELECT count(*)::int FROM ${schema.dashboardRepositories} r WHERE r.organization_id=${schema.organizations.id})`,
    workerCount: sql<number>`(SELECT count(DISTINCT p.worker_id)::int FROM ${schema.runnerPools} p WHERE p.organization_id=${schema.organizations.id})`,
  }).from(schema.organizations)
    .innerJoin(schema.memberships, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(and(eq(schema.memberships.userId, sql.placeholder("userId")), sql`EXISTS (SELECT 1 FROM ${schema.dashboardInstallations} i WHERE i.organization_id=${schema.organizations.id} AND i.state IN ('pending','approved'))`))
    .orderBy(asc(schema.organizations.login)).prepare("dashboard_list_organizations"),
  listAll: db.select({
    id: schema.organizations.id,
    name: schema.organizations.login,
    login: schema.organizations.login,
    role: sql<string>`COALESCE(${schema.memberships.role}, 'admin')`,
    repositoryCount: sql<number>`(SELECT count(*)::int FROM ${schema.dashboardRepositories} r WHERE r.organization_id=${schema.organizations.id})`,
    workerCount: sql<number>`(SELECT count(DISTINCT p.worker_id)::int FROM ${schema.runnerPools} p WHERE p.organization_id=${schema.organizations.id})`,
  }).from(schema.organizations)
    .leftJoin(schema.memberships, and(eq(schema.memberships.organizationId, schema.organizations.id), eq(schema.memberships.userId, sql.placeholder("userId"))))
    .where(sql`EXISTS (SELECT 1 FROM ${schema.dashboardInstallations} i WHERE i.organization_id=${schema.organizations.id} AND i.state IN ('pending','approved'))`)
    .orderBy(asc(schema.organizations.login)).prepare("dashboard_list_all_organizations"),
}));

export async function listOrganizations(db: DashboardDb, userId: string): Promise<OrganizationSummary[]> {
  return await organizationQueries(db).list.execute({ userId }) as OrganizationSummary[];
}
export async function listAllOrganizations(db: DashboardDb, userId: string): Promise<OrganizationSummary[]> {
  return await organizationQueries(db).listAll.execute({ userId }) as OrganizationSummary[];
}
function normalizeOverviewTimeseries(rows: Array<Record<string, unknown>>): OverviewTimeseriesPoint[] {
  return rows.map((row) => {
    const raw = row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket);
    const milliseconds = Date.parse(raw);
    return { bucket: Number.isNaN(milliseconds) ? new Date().toISOString() : new Date(milliseconds).toISOString(), pending: Number(row.pending ?? 0), running: Number(row.running ?? 0) };
  });
}

const timeseriesQueries = defineQueries((db) => ({
  series: db.select({
    bucket: sql<Date>`bucket`,
    pending: sql<number>`count(${schema.dashboardJobs.id}) FILTER (WHERE ${schema.dashboardJobs.queuedAt}<=bucket AND (${schema.dashboardJobs.startedAt} IS NULL OR ${schema.dashboardJobs.startedAt}>bucket) AND (${schema.dashboardJobs.completedAt} IS NULL OR ${schema.dashboardJobs.completedAt}>bucket))::int`,
    running: sql<number>`count(${schema.dashboardJobs.id}) FILTER (WHERE ${schema.dashboardJobs.startedAt} IS NOT NULL AND ${schema.dashboardJobs.startedAt}<=bucket AND (${schema.dashboardJobs.completedAt} IS NULL OR ${schema.dashboardJobs.completedAt}>bucket))::int`,
  }).from(sql`generate_series(date_trunc(CASE ${sql.placeholder("period")} WHEN '24h' THEN 'hour' ELSE 'day' END, now() - CASE ${sql.placeholder("period")} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END), date_trunc(CASE ${sql.placeholder("period")} WHEN '24h' THEN 'hour' ELSE 'day' END, now()), CASE ${sql.placeholder("period")} WHEN '24h' THEN interval '1 hour' ELSE interval '1 day' END) AS bucket`)
    .leftJoin(schema.dashboardJobs, and(
      sql`true`,
      sql`(${sql.placeholder("userId")}::text IS NULL OR EXISTS (SELECT 1 FROM ${schema.memberships} m WHERE m.organization_id=${schema.dashboardJobs.organizationId} AND m.user_id=${sql.placeholder("userId")}))`,
      sql`(${sql.placeholder("userId")}::text IS NOT NULL OR ${schema.dashboardJobs.organizationId}=${sql.placeholder("organizationId")})`,
    )).groupBy(sql`bucket`).orderBy(asc(sql`bucket`)).prepare("dashboard_overview_timeseries"),
  current: db.select({
    bucket: sql<Date>`now()`,
    pending: sql<number>`count(*) FILTER (WHERE ${schema.dashboardJobs.status}='queued')::int`,
    running: sql<number>`count(*) FILTER (WHERE ${schema.dashboardJobs.status}='in_progress')::int`,
  }).from(schema.dashboardJobs).where(and(
    sql`(${sql.placeholder("userId")}::text IS NULL OR EXISTS (SELECT 1 FROM ${schema.memberships} m WHERE m.organization_id=${schema.dashboardJobs.organizationId} AND m.user_id=${sql.placeholder("userId")}))`,
    sql`(${sql.placeholder("userId")}::text IS NOT NULL OR ${schema.dashboardJobs.organizationId}=${sql.placeholder("organizationId")})`,
  )).prepare("dashboard_overview_timeseries_current"),
}));
async function getOverviewTimeseries(db: DashboardDb, period: OverviewDto["period"], organizationId: string | null, userId?: string): Promise<OverviewTimeseriesPoint[]> {
  const parameters = { period, organizationId, userId: userId ?? null };
  const rows = await timeseriesQueries(db).series.execute(parameters) as Record<string, unknown>[];
  const currentRows = await timeseriesQueries(db).current.execute(parameters) as Record<string, unknown>[];
  const current = currentRows[0];
  const currentIsReal = current && (current.bucket instanceof Date || (typeof current.bucket === "string" && !Number.isNaN(Date.parse(current.bucket))));
  return normalizeOverviewTimeseries([...rows, ...(currentIsReal ? [current] : [])]);
}

const timeToStartQueries = defineQueries((db) => {
  const interval = sql`CASE ${sql.placeholder("period")} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END`;
  const unit = sql`CASE ${sql.placeholder("period")} WHEN '24h' THEN 'hour' ELSE 'day' END`;
  const step = sql`CASE ${sql.placeholder("period")} WHEN '24h' THEN interval '1 hour' ELSE interval '1 day' END`;
  const waitMs = sql`EXTRACT(EPOCH FROM (${schema.dashboardJobs.startedAt} - ${schema.dashboardJobs.queuedAt})) * 1000`;
  return {
    series: db.select({
      bucket: sql<Date>`bucket`,
      sampleCount: sql<number>`count(${schema.dashboardJobs.id})::int`,
      p50Ms: sql<number | null>`(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${waitMs}))::bigint`.mapWith(Number),
      p95Ms: sql<number | null>`(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${waitMs}))::bigint`.mapWith(Number),
    }).from(sql`generate_series(date_trunc(${unit}, now() - ${interval}), date_trunc(${unit}, now()), ${step}) AS bucket`)
      .leftJoin(schema.dashboardJobs, and(
        sql`${schema.dashboardJobs.startedAt} >= bucket AND ${schema.dashboardJobs.startedAt} < bucket + ${step}`,
        sql`${schema.dashboardJobs.startedAt} BETWEEN now() - ${interval} AND now()`,
        sql`${schema.dashboardJobs.startedAt} >= ${schema.dashboardJobs.queuedAt}`,
        sql`(${sql.placeholder("userId")}::text IS NULL OR EXISTS (SELECT 1 FROM ${schema.memberships} m WHERE m.organization_id=${schema.dashboardJobs.organizationId} AND m.user_id=${sql.placeholder("userId")}))`,
        sql`(${sql.placeholder("userId")}::text IS NOT NULL OR ${schema.dashboardJobs.organizationId}=${sql.placeholder("organizationId")})`,
      )).groupBy(sql`bucket`).orderBy(asc(sql`bucket`)).prepare("dashboard_overview_time_to_start"),
  };
});
async function getOverviewTimeToStart(db: DashboardDb, period: OverviewDto["period"], organizationId: string | null, userId?: string): Promise<OverviewDto["timeToStart"]> {
  const rows = await timeToStartQueries(db).series.execute({ period, organizationId, userId: userId ?? null });
  return rows.map(row => ({ ...row, bucket: normalizeTimestamp(row.bucket)! }));
}
type OverviewJobOutcome = NonNullable<OverviewDto["jobOutcomes"]>[number];
const outcomesQuery = defineQueries((db) => ({
  aggregate: db.select({
    outcome: sql<string>`CASE WHEN ${schema.dashboardJobs.status}='queued' THEN 'queued' WHEN ${schema.dashboardJobs.status}='in_progress' THEN 'running' ELSE CASE WHEN ${schema.dashboardJobs.conclusion}='success' THEN 'completed' ELSE 'failed' END END`.as("outcome"),
    platform: sql<string>`CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${schema.dashboardJobs.requestedLabels})='array' THEN ${schema.dashboardJobs.requestedLabels} ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%macos%') THEN 'macos' WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${schema.dashboardJobs.requestedLabels})='array' THEN ${schema.dashboardJobs.requestedLabels} ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%ubuntu%' OR lower(label) LIKE '%linux%') THEN 'ubuntu' WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${schema.dashboardJobs.requestedLabels})='array' THEN ${schema.dashboardJobs.requestedLabels} ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%windows%') THEN 'windows' ELSE 'other' END`.as("platform"),
    count: sql<number>`count(*)::int`,
  }).from(schema.dashboardJobs)
    .where(and(
      sql`(${sql.placeholder("userId")}::text IS NULL OR EXISTS (SELECT 1 FROM ${schema.memberships} m WHERE m.organization_id=${schema.dashboardJobs.organizationId} AND m.user_id=${sql.placeholder("userId")}))`,
      sql`(${sql.placeholder("userId")}::text IS NOT NULL OR ${schema.dashboardJobs.organizationId}=${sql.placeholder("organizationId")})`,
      sql`(${schema.dashboardJobs.status} IN ('queued','in_progress') OR ${schema.dashboardJobs.queuedAt} >= now() - CASE ${sql.placeholder("period")} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END)`,
    )).groupBy(sql`outcome, platform`).prepare("dashboard_overview_job_outcomes"),
}));
const overviewOutcomeOrder: OverviewJobOutcome["outcome"][] = ["queued", "running", "completed", "failed"];
const overviewPlatformOrder: (keyof OverviewJobOutcome["platforms"])[] = ["macos", "ubuntu", "windows", "other"];
function normalizeOverviewJobOutcomes(rows: Array<Record<string, unknown>>): OverviewJobOutcome[] {
  const cells = new Map<string, OverviewJobOutcome["platforms"]>();
  for (const outcome of overviewOutcomeOrder) cells.set(outcome, { macos: 0, ubuntu: 0, windows: 0, other: 0 });
  for (const row of rows) {
    const outcome = String(row.outcome) as OverviewJobOutcome["outcome"];
    const platform = String(row.platform) as keyof OverviewJobOutcome["platforms"];
    if (!cells.has(outcome) || !overviewPlatformOrder.includes(platform)) continue;
    cells.get(outcome)![platform] = Number(row.count ?? 0);
  }
  return overviewOutcomeOrder.map((outcome) => ({ outcome, platforms: cells.get(outcome)! }));
}
async function getOverviewJobOutcomes(db: DashboardDb, organizationId: string | null, period: OverviewDto["period"], userId?: string): Promise<OverviewJobOutcome[]> {
  const rows = await outcomesQuery(db).aggregate.execute({ organizationId, period, userId: userId ?? null }) as Record<string, unknown>[];
  return normalizeOverviewJobOutcomes(rows);
}
const overviewUtilization = (running: number, concurrency: number) => ({ vcpu: 0, memory: 0, storage: 0, pods: concurrency > 0 ? Math.min(1, running / concurrency) : 0 });
const runningContainerQueries = defineQueries((db) => ({
  list: db.select({
    id: schema.runnerLeases.id,
    organizationId: schema.runnerLeases.organizationId,
    jobId: schema.dashboardJobs.id,
    runId: schema.dashboardJobs.runId,
    jobName: schema.dashboardJobs.name,
    repositoryName: schema.dashboardRepositories.fullName,
    workflowName: schema.dashboardRuns.workflowName,
    workerName: schema.workers.name,
    runtime: schema.runnerPools.driver,
    startedAt: sql<Date>`COALESCE(${schema.runnerLeases.updatedAt},${schema.dashboardJobs.startedAt},${schema.runnerLeases.createdAt})`,
    cpuUsagePercent: sql<number | null>`(SELECT s.cpu_usage_percent FROM ${schema.dashboardJobResourceSamples} s WHERE s.organization_id=${schema.dashboardJobs.organizationId} AND s.job_id=${schema.dashboardJobs.id} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    memoryWorkingSetBytes: sql<string | null>`(SELECT s.memory_working_set_bytes::text FROM ${schema.dashboardJobResourceSamples} s WHERE s.organization_id=${schema.dashboardJobs.organizationId} AND s.job_id=${schema.dashboardJobs.id} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    memoryLimitBytes: sql<string | null>`(SELECT s.memory_limit_bytes::text FROM ${schema.dashboardJobResourceSamples} s WHERE s.organization_id=${schema.dashboardJobs.organizationId} AND s.job_id=${schema.dashboardJobs.id} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    diskUsageBytes: sql<string | null>`(SELECT s.disk_usage_bytes::text FROM ${schema.dashboardJobResourceSamples} s WHERE s.organization_id=${schema.dashboardJobs.organizationId} AND s.job_id=${schema.dashboardJobs.id} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    allocatedStorageBytes: sql<number>`COALESCE((${schema.runnerLeases.requested}->>'storageBytes')::bigint,(${schema.dashboardJobs.requested}->>'storageBytes')::bigint,(${schema.runnerPools.resources}->>'storageBytes')::bigint,0)`,
    sampledAt: sql<Date | null>`(SELECT s.occurred_at FROM ${schema.dashboardJobResourceSamples} s WHERE s.organization_id=${schema.dashboardJobs.organizationId} AND s.job_id=${schema.dashboardJobs.id} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
  }).from(schema.runnerLeases)
    .innerJoin(schema.dashboardJobs, and(eq(schema.dashboardJobs.organizationId, schema.runnerLeases.organizationId), eq(schema.dashboardJobs.githubJobId, schema.runnerLeases.githubJobId)))
    .innerJoin(schema.dashboardRuns, and(eq(schema.dashboardRuns.organizationId, schema.dashboardJobs.organizationId), eq(schema.dashboardRuns.id, schema.dashboardJobs.runId)))
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId)))
    .innerJoin(schema.workers, eq(schema.workers.id, schema.runnerLeases.workerId))
    .innerJoin(schema.runnerPools, eq(schema.runnerPools.id, schema.runnerLeases.poolId))
    .where(and(
      sql`${schema.runnerLeases.state} IN ('sandbox_ready','online','busy')`,
      eq(schema.dashboardJobs.status, "in_progress"),
      isNull(schema.dashboardJobs.completedAt),
      sql`(${sql.placeholder("userId")}::text IS NOT NULL OR ${schema.runnerLeases.organizationId}=${sql.placeholder("organizationId")})`,
      sql`(${sql.placeholder("userId")}::text IS NULL OR EXISTS (SELECT 1 FROM ${schema.memberships} m WHERE m.organization_id=${schema.runnerLeases.organizationId} AND m.user_id=${sql.placeholder("userId")}))`,
    )).orderBy(desc(sql`COALESCE(${schema.runnerLeases.updatedAt},${schema.dashboardJobs.startedAt},${schema.runnerLeases.createdAt})`), desc(schema.runnerLeases.id))
    .prepare("dashboard_overview_running_containers"),
}));
async function getOverviewRunningContainers(db: DashboardDb, organizationId: string | null, userId?: string): Promise<NonNullable<OverviewDto["runningContainers"]>> {
  const rows = await runningContainerQueries(db).list.execute({ organizationId, userId: userId ?? null }) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id), organizationId: String(row.organizationId), jobId: String(row.jobId), runId: String(row.runId), jobName: String(row.jobName), repositoryName: String(row.repositoryName), workflowName: String(row.workflowName), workerName: String(row.workerName), runtime: String(row.runtime), startedAt: normalizeTimestamp(row.startedAt)!, sampledAt: row.sampledAt == null ? null : normalizeTimestamp(row.sampledAt), cpuUsagePercent: row.cpuUsagePercent == null ? null : Number(row.cpuUsagePercent), memoryWorkingSetBytes: row.memoryWorkingSetBytes == null ? null : Number(row.memoryWorkingSetBytes), memoryLimitBytes: row.memoryLimitBytes == null ? null : Number(row.memoryLimitBytes), diskUsageBytes: row.diskUsageBytes == null ? null : Number(row.diskUsageBytes), allocatedStorageBytes: Number(row.allocatedStorageBytes ?? 0),
  }));
}
const overviewQueries = defineQueries((db) => {
  const claimedLease = db.select({ id: schema.runnerLeases.id }).from(schema.runnerLeases).where(and(
    eq(schema.runnerLeases.organizationId, schema.dashboardJobs.organizationId),
    eq(schema.runnerLeases.githubJobId, schema.dashboardJobs.githubJobId),
    or(inArray(schema.runnerLeases.state, ["reserved", "requested", "dispatched", "provisioning", "sandbox_ready", "online", "busy"]), inArray(schema.runnerLeases.cleanupState, ["pending", "failed"])),
  ));
  const queued = sql<number>`count(*) FILTER (WHERE ${schema.dashboardJobs.status}='queued' AND NOT EXISTS (${claimedLease}))::int`;
  const periodStart = sql`now() - CASE ${sql.placeholder("period")} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END`;
  // Queue samples end at pickup; runtime samples end at completion. In-flight
  // jobs contribute only their observed queue wait, never a partial runtime.
  const queueSample = sql`${schema.dashboardJobs.startedAt} BETWEEN ${periodStart} AND now() AND ${schema.dashboardJobs.startedAt} >= ${schema.dashboardJobs.queuedAt}`;
  const durationSample = sql`${schema.dashboardJobs.status}='completed' AND ${schema.dashboardJobs.completedAt} BETWEEN ${periodStart} AND now() AND ${schema.dashboardJobs.completedAt} >= ${schema.dashboardJobs.startedAt}`;
  const queueWaitMs = sql`EXTRACT(EPOCH FROM (${schema.dashboardJobs.startedAt} - ${schema.dashboardJobs.queuedAt})) * 1000`;
  const runtimeMs = sql`EXTRACT(EPOCH FROM (${schema.dashboardJobs.completedAt} - ${schema.dashboardJobs.startedAt})) * 1000`;
  const timingPercentiles = {
    queueP50Ms: sql<number>`COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${queueWaitMs}) FILTER (WHERE ${queueSample}),0)::bigint`.mapWith(Number),
    queueP95Ms: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${queueWaitMs}) FILTER (WHERE ${queueSample}),0)::bigint`.mapWith(Number),
    durationP50Ms: sql<number>`COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${runtimeMs}) FILTER (WHERE ${durationSample}),0)::bigint`.mapWith(Number),
    durationP95Ms: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${runtimeMs}) FILTER (WHERE ${durationSample}),0)::bigint`.mapWith(Number),
  };
  return {
  queueReasons: db.select({
    code: sql<"eligible" | "run_not_dispatchable" | "repository_unavailable" | "installation_not_approved">`CASE WHEN ${schema.dashboardRuns.status} NOT IN ('queued','in_progress') THEN 'run_not_dispatchable' WHEN ${schema.dashboardRepositories.available} IS DISTINCT FROM true THEN 'repository_unavailable' WHEN ${schema.dashboardInstallations.state} IS DISTINCT FROM 'approved' THEN 'installation_not_approved' ELSE 'eligible' END`.as("code"),
    count: sql<number>`count(*)::int`,
  }).from(schema.dashboardJobs)
    .innerJoin(schema.dashboardRuns, eq(schema.dashboardRuns.id, schema.dashboardJobs.runId))
    .leftJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId), eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId)))
    .leftJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId), eq(schema.dashboardInstallations.organizationId, schema.dashboardRuns.organizationId)))
    .where(and(eq(schema.dashboardJobs.status, "queued"),
      sql`(${sql.placeholder("organizationId")}::uuid IS NULL OR ${schema.dashboardJobs.organizationId}=${sql.placeholder("organizationId")}::uuid)`,
      sql`(${sql.placeholder("userId")}::text IS NULL OR EXISTS (SELECT 1 FROM ${schema.memberships} m WHERE m.organization_id=${schema.dashboardJobs.organizationId} AND m.user_id=${sql.placeholder("userId")}))`,
      sql`NOT EXISTS (SELECT 1 FROM ${schema.runnerLeases} ql WHERE ql.organization_id=${schema.dashboardJobs.organizationId} AND ql.github_job_id=${schema.dashboardJobs.githubJobId} AND (ql.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy') OR ql.cleanup_state IN ('pending','failed')))`
    )).groupBy(sql`code`).prepare("dashboard_overview_queue_reasons"),
  organization: db.select({
    organizationId: sql<string>`${sql.placeholder("organizationId")}::text`,
    period: sql<OverviewDto["period"]>`${sql.placeholder("period")}::text`,
    queued,
    running: sql<number>`(SELECT count(*)::int FROM ${schema.runnerLeases} l JOIN ${schema.dashboardJobs} active_j ON active_j.organization_id=l.organization_id AND active_j.github_job_id=l.github_job_id WHERE active_j.organization_id=${sql.placeholder("organizationId")} AND l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy'))`,
    completed: sql<number>`count(*) FILTER (WHERE ${schema.dashboardJobs.status}='completed' AND ${schema.dashboardJobs.conclusion}='success')::int`,
    failed: sql<number>`count(*) FILTER (WHERE ${schema.dashboardJobs.status}='completed' AND ${schema.dashboardJobs.conclusion}<>'success')::int`,
    ...timingPercentiles,
    concurrency: sql<number>`COALESCE((SELECT sum((p.resources->>'concurrency')::int)::int FROM ${schema.runnerPools} p WHERE p.enabled AND (p.organization_id=${sql.placeholder("organizationId")} OR p.organization_id IS NULL)),0)::int`,
  }).from(schema.dashboardJobs).where(eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId"))).prepare("dashboard_overview"),
  all: db.select({
    organizationId: sql<string>`'all'`,
    period: sql<OverviewDto["period"]>`${sql.placeholder("period")}::text`,
    queued,
    running: sql<number>`(SELECT count(*)::int FROM ${schema.runnerLeases} l JOIN ${schema.dashboardJobs} active_j ON active_j.organization_id=l.organization_id AND active_j.github_job_id=l.github_job_id JOIN ${schema.memberships} am ON am.organization_id=active_j.organization_id AND am.user_id=${sql.placeholder("userId")} WHERE l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy'))`,
    completed: sql<number>`count(*) FILTER (WHERE ${schema.dashboardJobs.status}='completed' AND ${schema.dashboardJobs.conclusion}='success')::int`,
    failed: sql<number>`count(*) FILTER (WHERE ${schema.dashboardJobs.status}='completed' AND ${schema.dashboardJobs.conclusion}<>'success')::int`,
    ...timingPercentiles,
    concurrency: sql<number>`COALESCE((SELECT sum((p.resources->>'concurrency')::int)::int FROM ${schema.runnerPools} p LEFT JOIN ${schema.memberships} pm ON pm.organization_id=p.organization_id AND pm.user_id=${sql.placeholder("userId")} WHERE p.enabled AND (p.organization_id IS NULL OR pm.user_id IS NOT NULL)),0)::int`,
  }).from(schema.dashboardJobs).innerJoin(schema.memberships, and(eq(schema.memberships.organizationId, schema.dashboardJobs.organizationId), eq(schema.memberships.userId, sql.placeholder("userId"))))
    .prepare("dashboard_all_overview"),
  };
});
async function getOverviewQueueReasons(db: DashboardDb, organizationId: string | null, userId: string | null): Promise<NonNullable<OverviewDto["queueReasons"]>> {
  const rows = await overviewQueries(db).queueReasons.execute({ organizationId, userId }) as Array<{ code: "eligible" | "run_not_dispatchable" | "repository_unavailable" | "installation_not_approved"; count: number }>;
  return rows.map(({ code, count }) => ({ code, count: Number(count) }));
}

export async function getOverview(db: DashboardDb, organizationId: string, period: OverviewDto["period"]): Promise<OverviewDto> {
  const [row] = await overviewQueries(db).organization.execute({ organizationId, period }) as OverviewDto[];
  return { ...row, queueReasons: await getOverviewQueueReasons(db, organizationId, null), utilization: overviewUtilization(row.running, row.concurrency), costSavings: await getGithubRunnerCostSavings(db, organizationId, period), timeseries: await getOverviewTimeseries(db, period, organizationId), timeToStart: await getOverviewTimeToStart(db, period, organizationId), jobOutcomes: await getOverviewJobOutcomes(db, organizationId, period), runningContainers: await getOverviewRunningContainers(db, organizationId) };
}
export async function getAllOverview(db: DashboardDb, userId: string, period: OverviewDto["period"]): Promise<OverviewDto> {
  const [row] = await overviewQueries(db).all.execute({ userId, period }) as OverviewDto[];
  return { ...row, organizationId: "all", queueReasons: await getOverviewQueueReasons(db, null, userId), utilization: overviewUtilization(row.running, row.concurrency), costSavings: await getGithubRunnerCostSavings(db, "all", period, userId), timeseries: await getOverviewTimeseries(db, period, null, userId), timeToStart: await getOverviewTimeToStart(db, period, null, userId), jobOutcomes: await getOverviewJobOutcomes(db, null, period, userId), runningContainers: await getOverviewRunningContainers(db, null, userId) };
}

const repositoryQueries = defineQueries((db) => ({
  organization: db.select({
    id: schema.dashboardRepositories.id,
    organizationId: schema.dashboardRepositories.organizationId,
    name: schema.dashboardRepositories.name,
    fullName: schema.dashboardRepositories.fullName,
    visibility: schema.dashboardRepositories.visibility,
    available: schema.dashboardRepositories.available,
    installationId: schema.dashboardRepositories.installationId,
    discoveryState: sql<string>`CASE WHEN ${schema.dashboardRepositories.discoveryError}='github_403' AND ${schema.dashboardRepositories.discoveryRetryAt}>now() THEN 'paused' WHEN ${schema.dashboardRepositories.discoveryError}='github_rate_limited' AND ${schema.dashboardRepositories.discoveryRetryAt}>now() THEN 'rate_limited' WHEN ${schema.dashboardRepositories.discoveryError} IN ('github_403','github_rate_limited') AND ${schema.dashboardRepositories.discoveryRetryAt}<=now() THEN 'queued' ELSE 'active' END`,
    discoveryRetryAt: schema.dashboardRepositories.discoveryRetryAt,
  }).from(schema.dashboardRepositories)
    .innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.organizationId, schema.dashboardRepositories.organizationId), eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId)))
    .where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), sql`(${sql.placeholder("cursor")}::uuid IS NULL OR (${schema.dashboardRepositories.fullName},${schema.dashboardRepositories.id}) > (SELECT c.full_name,c.id FROM dashboard_repositories c WHERE c.id=${sql.placeholder("cursor")}::uuid))`,
      sql`(${sql.placeholder("search")}='' OR lower(${schema.dashboardRepositories.fullName}) LIKE lower(${sql.placeholder("pattern")}))`,
      sql`(${sql.placeholder("availability")}::boolean IS NULL OR ${schema.dashboardRepositories.available}=${sql.placeholder("availability")})`,
      sql`(${sql.placeholder("visibility")}='' OR ${schema.dashboardRepositories.visibility}=${sql.placeholder("visibility")})`))
    .orderBy(asc(schema.dashboardRepositories.fullName), asc(schema.dashboardRepositories.id)).limit(sql.placeholder("limit")).prepare("dashboard_list_repositories"),
  all: db.select({
    id: schema.dashboardRepositories.id,
    organizationId: schema.dashboardRepositories.organizationId,
    name: schema.dashboardRepositories.name,
    fullName: schema.dashboardRepositories.fullName,
    visibility: schema.dashboardRepositories.visibility,
    available: schema.dashboardRepositories.available,
    installationId: schema.dashboardRepositories.installationId,
    discoveryState: sql<string>`CASE WHEN ${schema.dashboardRepositories.discoveryError}='github_403' AND ${schema.dashboardRepositories.discoveryRetryAt}>now() THEN 'paused' WHEN ${schema.dashboardRepositories.discoveryError}='github_rate_limited' AND ${schema.dashboardRepositories.discoveryRetryAt}>now() THEN 'rate_limited' WHEN ${schema.dashboardRepositories.discoveryError} IN ('github_403','github_rate_limited') AND ${schema.dashboardRepositories.discoveryRetryAt}<=now() THEN 'queued' ELSE 'active' END`,
    discoveryRetryAt: schema.dashboardRepositories.discoveryRetryAt,
  }).from(schema.dashboardRepositories)
    .innerJoin(schema.memberships, and(eq(schema.memberships.organizationId, schema.dashboardRepositories.organizationId), eq(schema.memberships.userId, sql.placeholder("userId"))))
    .innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.organizationId, schema.dashboardRepositories.organizationId), eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId)))
    .where(and(sql`(${sql.placeholder("cursor")}::uuid IS NULL OR (${schema.dashboardRepositories.fullName},${schema.dashboardRepositories.id}) > (SELECT c.full_name,c.id FROM dashboard_repositories c WHERE c.id=${sql.placeholder("cursor")}::uuid))`,
      sql`(${sql.placeholder("search")}='' OR lower(${schema.dashboardRepositories.fullName}) LIKE lower(${sql.placeholder("pattern")}))`,
      sql`(${sql.placeholder("availability")}::boolean IS NULL OR ${schema.dashboardRepositories.available}=${sql.placeholder("availability")})`,
      sql`(${sql.placeholder("visibility")}='' OR ${schema.dashboardRepositories.visibility}=${sql.placeholder("visibility")})`))
    .orderBy(asc(schema.dashboardRepositories.fullName), asc(schema.dashboardRepositories.id)).limit(sql.placeholder("limit")).prepare("dashboard_list_all_repositories"),
}));

export async function listRepositories(
  db: DashboardDb,
  organizationId: string,
  limit = 50,
  cursor: string | null = null,
  filters: { search?: string; availability?: boolean; visibility?: string } = {},
): Promise<CursorPage<RepositorySummary>> {
  const search = filters.search?.trim() ?? "";
  const rows = await repositoryQueries(db).organization.execute({
    organizationId, cursor, search, pattern: `%${search}%`, availability: filters.availability ?? null,
    visibility: filters.visibility ?? "", limit: limit + 1,
  }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizeRepository);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const milliseconds = Date.parse(raw);
  return Number.isNaN(milliseconds) ? raw : new Date(milliseconds).toISOString();
}
function normalizeRepository(row: Record<string, unknown>): RepositorySummary {
  return { ...row, discoveryRetryAt: normalizeTimestamp(row.discoveryRetryAt) } as RepositorySummary;
}
function derivedDurationMs(startedAt: string | null, completedAt: string | null, status: unknown): number {
  if (!startedAt || status === "queued") return 0;
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
function normalizeRunSummary(row: Record<string, unknown>): RunSummary {
  const startedAt = normalizeTimestamp(row.startedAt);
  const completedAt = normalizeTimestamp(row.completedAt);
  const storedDurationMs = Number(row.durationMs);
  return {
    ...row,
    runNumber: Number(row.runNumber),
    queuedAt: normalizeTimestamp(row.queuedAt)!,
    startedAt,
    completedAt,
    durationMs: storedDurationMs > 0 ? storedDurationMs : derivedDurationMs(startedAt, completedAt, row.status),
    allocationState: row.allocationState === "mars" || (row.allocationState == null && row.runtimeBoundary != null) ? "mars" : "external",
  } as RunSummary;
}
const runRuntimeBoundary = sql<string | null>`COALESCE(${schema.dashboardRuns.runtimeBoundary}, (SELECT CASE pool.driver WHEN 'tart-vm' THEN 'Tart VM' WHEN 'kata-k3s' THEN 'Kata VM-backed container' WHEN 'windows-hyperv' THEN 'Hyper-V isolated container' WHEN 'windows-process-container' THEN 'Process-isolated Windows container' WHEN 'linux-docker-container' THEN 'Docker Linux container' END FROM ${schema.dashboardJobs} j JOIN ${schema.runnerLeases} l ON l.github_job_id=j.github_job_id JOIN ${schema.runnerPools} pool ON pool.id=l.pool_id WHERE j.run_id=${schema.dashboardRuns.id} ORDER BY l.created_at DESC LIMIT 1))`;
const runProjection = () => ({
  id: schema.dashboardRuns.id,
  organizationId: schema.dashboardRuns.organizationId,
  repositoryId: schema.dashboardRuns.repositoryId,
  repositoryName: schema.dashboardRepositories.name,
  runNumber: schema.dashboardRuns.runNumber,
  runAttempt: schema.dashboardRuns.runAttempt,
  workflowName: schema.dashboardRuns.workflowName,
  event: schema.dashboardRuns.event,
  branch: schema.dashboardRuns.branch,
  commitSha: schema.dashboardRuns.commitSha,
  actorLogin: schema.dashboardRuns.actorLogin,
  status: schema.dashboardRuns.status,
  conclusion: schema.dashboardRuns.conclusion,
  queuedAt: schema.dashboardRuns.queuedAt,
  startedAt: schema.dashboardRuns.startedAt,
  completedAt: schema.dashboardRuns.completedAt,
  durationMs: sql<number>`0::bigint`,
  runtimeBoundary: runRuntimeBoundary,
  allocationState: sql<string>`CASE WHEN EXISTS (SELECT 1 FROM ${schema.dashboardJobs} allocation_job WHERE allocation_job.organization_id=${schema.dashboardRuns.organizationId} AND allocation_job.run_id=${schema.dashboardRuns.id} AND ((jsonb_typeof(allocation_job.requested_labels)='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allocation_job.requested_labels) allocation_label WHERE lower(allocation_label) LIKE 'mars-%')) OR (jsonb_typeof(allocation_job.requested_labels)='string' AND lower(allocation_job.requested_labels #>> '{}') LIKE '%"mars-%'))) THEN 'mars' ELSE 'external' END`,
});
const runSearch = sql`(${sql.placeholder("search")}='' OR strpos(lower(concat_ws(' ', ${schema.dashboardRepositories.fullName}, ${schema.dashboardRuns.workflowName}, ${schema.dashboardRuns.branch}, ${schema.dashboardRuns.actorLogin}, ${schema.dashboardRuns.commitSha}, COALESCE(${schema.dashboardRuns.conclusion},replace(${schema.dashboardRuns.status},'_',' ')), ${runRuntimeBoundary})), lower(${sql.placeholder("search")}))>0)`;
const runQueries = defineQueries((db) => ({
  organization: db.select(runProjection()).from(schema.dashboardRuns)
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId)))
    .where(and(eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")),
      sql`(${sql.placeholder("cursor")}::uuid IS NULL OR (${schema.dashboardRuns.queuedAt},${schema.dashboardRuns.id}) < (SELECT c.queued_at,c.id FROM dashboard_runs c WHERE c.id=${sql.placeholder("cursor")}::uuid))`,
      sql`(${sql.placeholder("from")}::timestamptz IS NULL OR ${schema.dashboardRuns.queuedAt}>=${sql.placeholder("from")}::timestamptz)`,
      sql`(${sql.placeholder("runner")}='all' OR (CASE WHEN EXISTS (SELECT 1 FROM ${schema.dashboardJobs} allocation_job WHERE allocation_job.organization_id=${schema.dashboardRuns.organizationId} AND allocation_job.run_id=${schema.dashboardRuns.id} AND ((jsonb_typeof(allocation_job.requested_labels)='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allocation_job.requested_labels) allocation_label WHERE lower(allocation_label) LIKE 'mars-%')) OR (jsonb_typeof(allocation_job.requested_labels)='string' AND lower(allocation_job.requested_labels #>> '{}') LIKE '%"mars-%'))) THEN 'mars' ELSE 'external' END)=${sql.placeholder("runner")})`,
      runSearch))
    .orderBy(desc(schema.dashboardRuns.queuedAt), desc(schema.dashboardRuns.id)).limit(sql.placeholder("limit")).prepare("dashboard_list_runs"),
  all: db.select(runProjection()).from(schema.dashboardRuns)
    .innerJoin(schema.memberships, and(eq(schema.memberships.organizationId, schema.dashboardRuns.organizationId), eq(schema.memberships.userId, sql.placeholder("userId"))))
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId)))
    .where(and(
      sql`(${sql.placeholder("cursor")}::uuid IS NULL OR (${schema.dashboardRuns.queuedAt},${schema.dashboardRuns.id}) < (SELECT c.queued_at,c.id FROM dashboard_runs c WHERE c.id=${sql.placeholder("cursor")}::uuid))`,
      sql`(${sql.placeholder("from")}::timestamptz IS NULL OR ${schema.dashboardRuns.queuedAt}>=${sql.placeholder("from")}::timestamptz)`,
      sql`(${sql.placeholder("runner")}='all' OR (CASE WHEN EXISTS (SELECT 1 FROM ${schema.dashboardJobs} allocation_job WHERE allocation_job.organization_id=${schema.dashboardRuns.organizationId} AND allocation_job.run_id=${schema.dashboardRuns.id} AND ((jsonb_typeof(allocation_job.requested_labels)='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allocation_job.requested_labels) allocation_label WHERE lower(allocation_label) LIKE 'mars-%')) OR (jsonb_typeof(allocation_job.requested_labels)='string' AND lower(allocation_job.requested_labels #>> '{}') LIKE '%"mars-%'))) THEN 'mars' ELSE 'external' END)=${sql.placeholder("runner")})`,
      runSearch))
    .orderBy(desc(schema.dashboardRuns.queuedAt), desc(schema.dashboardRuns.id)).limit(sql.placeholder("limit")).prepare("dashboard_list_all_runs"),
}));
export async function listRuns(db: DashboardDb, organizationId: string, limit = 50, cursor: string | null = null, search = "", filters: { from?: string; runner?: "all" | "mars" | "external" } = {}): Promise<CursorPage<RunSummary>> {
  const rows = await runQueries(db).organization.execute({ organizationId, cursor, from: filters.from ?? null, runner: filters.runner ?? "all", search, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizeRunSummary);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}
export async function listAllRepositories(db: DashboardDb, userId: string, limit = 50, cursor: string | null = null, filters: { search?: string; availability?: boolean; visibility?: string } = {}): Promise<CursorPage<RepositorySummary>> {
  const search = filters.search?.trim() ?? "";
  const rows = await repositoryQueries(db).all.execute({
    userId, cursor, search, pattern: `%${search}%`, availability: filters.availability ?? null,
    visibility: filters.visibility ?? "", limit: limit + 1,
  }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizeRepository);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
export async function listAllRuns(db: DashboardDb, userId: string, limit = 50, cursor: string | null = null, search = "", filters: { from?: string; runner?: "all" | "mars" | "external" } = {}): Promise<CursorPage<RunSummary>> {
  const rows = await runQueries(db).all.execute({ userId, cursor, from: filters.from ?? null, runner: filters.runner ?? "all", search, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizeRunSummary);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}
function analysisMetricsProjection() {
  const a = schema.pipelineFailureAnalyses;
  return {
    queuedAt: a.createdAt, startedAt: a.startedAt, finishedAt: a.finishedAt, providerCalledAt: a.providerCalledAt,
    inputTokens: a.inputTokens, outputTokens: a.outputTokens,
    inputUsdPerMillionTokens: a.inputUsdPerMillionTokens, outputUsdPerMillionTokens: a.outputUsdPerMillionTokens,
  };
}
function analysisMetrics(row: Record<string, unknown>, now: number) {
  const numeric = (value: unknown): number | null => value == null ? null : Number(value);
  return getPipelineAnalysisMetrics({
    state: String(row.state), queuedAt: normalizeTimestamp(row.queuedAt)!,
    startedAt: normalizeTimestamp(row.startedAt), finishedAt: normalizeTimestamp(row.finishedAt), calledAt: normalizeTimestamp(row.providerCalledAt),
    inputTokens: numeric(row.inputTokens), outputTokens: numeric(row.outputTokens),
    inputUsdPerMillionTokens: numeric(row.inputUsdPerMillionTokens), outputUsdPerMillionTokens: numeric(row.outputUsdPerMillionTokens),
  }, now);
}
const analysisWorkQueries = defineQueries(db => {
  const a = schema.pipelineFailureAnalyses, r = schema.dashboardRuns, repo = schema.dashboardRepositories;
  const projection = {
    id: a.id, organizationId: a.organizationId, repositoryId: a.repositoryId,
    repositoryName: repo.fullName, runId: a.runId, runAttempt: a.runAttempt,
    runNumber: sql<number>`COALESCE((${a.source}->'run'->>'number')::bigint, ${r.runNumber})`,
    workflowName: sql<string>`COALESCE(${a.source}->'run'->>'workflowName', ${r.workflowName})`,
    state: a.state, providerName: a.providerName, model: a.model,
    result: a.result, errorCode: a.errorCode, ...analysisMetricsProjection(),
  };
  const selected = sql`((${sql.placeholder("view")}='queue' AND ${a.state} IN ('pending','running')) OR (${sql.placeholder("view")}='history' AND ${a.state} IN ('completed','failed','skipped')))`;
  const afterCursor = sql`(${sql.placeholder("cursor")}::uuid IS NULL OR CASE WHEN ${sql.placeholder("view")}='queue' THEN (${a.createdAt},${a.id}) > (SELECT c.created_at,c.id FROM pipeline_failure_analyses c WHERE c.id=${sql.placeholder("cursor")}::uuid) ELSE (${a.createdAt},${a.id}) < (SELECT c.created_at,c.id FROM pipeline_failure_analyses c WHERE c.id=${sql.placeholder("cursor")}::uuid) END)`;
  const ordering = [
    asc(sql`CASE WHEN ${sql.placeholder("view")}='queue' THEN ${a.createdAt} END`),
    asc(sql`CASE WHEN ${sql.placeholder("view")}='queue' THEN ${a.id} END`),
    desc(sql`CASE WHEN ${sql.placeholder("view")}='history' THEN ${a.createdAt} END`),
    desc(sql`CASE WHEN ${sql.placeholder("view")}='history' THEN ${a.id} END`),
  ];
  const runJoin = and(eq(r.organizationId, a.organizationId), eq(r.repositoryId, a.repositoryId), eq(r.id, a.runId));
  const repoJoin = and(eq(repo.organizationId, a.organizationId), eq(repo.id, a.repositoryId));
  return {
    organization: db.select(projection).from(a).innerJoin(r, runJoin).innerJoin(repo, repoJoin)
      .where(and(eq(a.organizationId, sql.placeholder("organizationId")), selected, afterCursor))
      .orderBy(...ordering).limit(sql.placeholder("limit")).prepare("dashboard_analysis_work"),
    all: db.select(projection).from(a).innerJoin(r, runJoin).innerJoin(repo, repoJoin)
      .innerJoin(schema.memberships, and(eq(schema.memberships.organizationId, a.organizationId), eq(schema.memberships.userId, sql.placeholder("userId"))))
      .where(and(selected, afterCursor))
      .orderBy(...ordering).limit(sql.placeholder("limit")).prepare("dashboard_all_analysis_work"),
    comments: db.select({
      analysisId: schema.pipelineAnalysisComments.analysisId,
      prNumber: schema.pipelineAnalysisComments.prNumber,
      state: schema.pipelineAnalysisComments.state,
      commentUrl: schema.pipelineAnalysisComments.commentUrl,
      commentBody: schema.pipelineAnalysisComments.commentBody,
      errorCode: schema.pipelineAnalysisComments.errorCode,
    }).from(schema.pipelineAnalysisComments).where(sql`${schema.pipelineAnalysisComments.analysisId} IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.placeholder("analysisIds")}::jsonb))`).orderBy(asc(schema.pipelineAnalysisComments.prNumber)).prepare("dashboard_analysis_work_comments"),
  };
});
export async function listPipelineAnalysisWork(db: DashboardDb, scope: { organizationId: string } | { userId: string }, limit = 50, cursor: string | null = null, view: "queue" | "history" = "queue"): Promise<CursorPage<PipelineAnalysisWork>> {
  const queries = analysisWorkQueries(db);
  const rows = await ("organizationId" in scope ? queries.organization : queries.all).execute({ ...scope, limit: limit + 1, cursor, view }) as Record<string, unknown>[];
  const selectedRows = rows.slice(0, limit);
  const comments = selectedRows.length
    ? await queries.comments.execute({ analysisIds: JSON.stringify(selectedRows.map(row => String(row.id))) }) as Record<string, unknown>[]
    : [];
  const byAnalysis = new Map<string, PipelineAnalysisWork["comments"]>();
  for (const comment of comments) {
    const analysisId = String(comment.analysisId);
    const list = byAnalysis.get(analysisId) ?? [];
    list.push({
      prNumber: Number(comment.prNumber),
      state: comment.state as PipelineAnalysisWork["comments"][number]["state"],
      commentUrl: comment.commentUrl == null ? null : String(comment.commentUrl),
      commentBody: comment.commentBody == null ? null : String(comment.commentBody),
      errorCode: comment.errorCode == null ? null : String(comment.errorCode),
    });
    byAnalysis.set(analysisId, list);
  }
  const now = Date.now();
  const items = selectedRows.map((row): PipelineAnalysisWork => ({
    id: String(row.id), organizationId: String(row.organizationId), repositoryId: String(row.repositoryId),
    repositoryName: String(row.repositoryName), runId: String(row.runId),
    runNumber: Number(row.runNumber), runAttempt: Number(row.runAttempt), workflowName: String(row.workflowName),
    state: row.state as PipelineAnalysisWork["state"], providerName: String(row.providerName), model: String(row.model),
    result: row.result == null ? null : row.result as PipelineAnalysisWork["result"],
    comments: byAnalysis.get(String(row.id)) ?? [],
    errorCode: row.errorCode == null ? null : String(row.errorCode), metrics: analysisMetrics(row, now),
  }));
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}
export async function listAllPools(db: DashboardDb, userId: string, limit = 50): Promise<CursorPage<PoolSummary>> {
  const rows = await poolQueries(db).all.execute({ userId, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizePool);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
const runDetailQueries = defineQueries((db) => ({
  failureAnalysis: db.select({
    id: schema.pipelineFailureAnalyses.id,
    runAttempt: schema.pipelineFailureAnalyses.runAttempt,
    state: schema.pipelineFailureAnalyses.state,
    providerName: schema.pipelineFailureAnalyses.providerName,
    model: schema.pipelineFailureAnalyses.model,
    result: schema.pipelineFailureAnalyses.result,
    errorCode: schema.pipelineFailureAnalyses.errorCode,
    ...analysisMetricsProjection(),
  }).from(schema.pipelineFailureAnalyses).where(and(
    eq(schema.pipelineFailureAnalyses.organizationId, sql.placeholder("organizationId")),
    eq(schema.pipelineFailureAnalyses.runId, sql.placeholder("runId")),
    eq(schema.pipelineFailureAnalyses.runAttempt, sql.placeholder("runAttempt")),
  )).limit(1).prepare("dashboard_run_detail_failure_analysis"),
  failureAnalysisComments: db.select({
    prNumber: schema.pipelineAnalysisComments.prNumber,
    state: schema.pipelineAnalysisComments.state,
    commentUrl: schema.pipelineAnalysisComments.commentUrl,
    commentBody: schema.pipelineAnalysisComments.commentBody,
    errorCode: schema.pipelineAnalysisComments.errorCode,
  }).from(schema.pipelineAnalysisComments).where(eq(schema.pipelineAnalysisComments.analysisId, sql.placeholder("analysisId")))
    .orderBy(asc(schema.pipelineAnalysisComments.prNumber)).prepare("dashboard_run_detail_failure_analysis_comments"),
  failureAnalysisEnabled: db.select({ enabled: sql<boolean>`COALESCE(${schema.repositoryFailureAnalysisSettings.enabled}, false) OR EXISTS (SELECT 1 FROM ${schema.globalFailureAnalysisSettings} WHERE ${schema.globalFailureAnalysisSettings.singleton}=true AND ${schema.globalFailureAnalysisSettings.enableAll}=true)` }).from(schema.dashboardRepositories).leftJoin(schema.repositoryFailureAnalysisSettings, and(
    eq(schema.repositoryFailureAnalysisSettings.organizationId, schema.dashboardRepositories.organizationId),
    eq(schema.repositoryFailureAnalysisSettings.repositoryId, schema.dashboardRepositories.id),
  )).where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.id, sql.placeholder("repositoryId")))).limit(1).prepare("dashboard_run_detail_failure_analysis_enabled"),
  jobs: db.select({
    id: schema.dashboardJobs.id,
    name: schema.dashboardJobs.name,
    status: schema.dashboardJobs.status,
    conclusion: schema.dashboardJobs.conclusion,
    stage: schema.dashboardJobs.stage,
    runnerName: schema.dashboardJobs.runnerName,
    logsState: schema.dashboardJobs.logsState,
    requested: schema.dashboardJobs.requested,
    requestedLabels: schema.dashboardJobs.requestedLabels,
    observed: schema.dashboardJobs.observed,
    queuedAt: schema.dashboardJobs.queuedAt,
    startedAt: schema.dashboardJobs.startedAt,
    completedAt: schema.dashboardJobs.completedAt,
    terminalResult: sql<unknown>`(${db.select({ terminalResult: schema.runnerLeases.terminalResult }).from(schema.runnerLeases).where(eq(schema.runnerLeases.githubJobId, schema.dashboardJobs.githubJobId)).orderBy(desc(schema.runnerLeases.updatedAt)).limit(1)})`,
  }).from(schema.dashboardJobs).where(and(
    eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId")),
    eq(schema.dashboardJobs.runId, sql.placeholder("runId")),
    sql`${schema.dashboardJobs.runAttempt}=(SELECT run_attempt FROM ${schema.dashboardRuns} WHERE organization_id=${sql.placeholder("organizationId")} AND id=${sql.placeholder("runId")})`,
  )).orderBy(asc(schema.dashboardJobs.id)).prepare("dashboard_run_detail_jobs"),
  steps: db.select({
    id: schema.dashboardJobSteps.id,
    jobId: schema.dashboardJobSteps.jobId,
    name: schema.dashboardJobSteps.name,
    number: schema.dashboardJobSteps.number,
    status: schema.dashboardJobSteps.status,
    conclusion: schema.dashboardJobSteps.conclusion,
    queuedAt: schema.dashboardJobSteps.queuedAt,
    startedAt: schema.dashboardJobSteps.startedAt,
    completedAt: schema.dashboardJobSteps.completedAt,
    durationMs: schema.dashboardJobSteps.durationMs,
  }).from(schema.dashboardJobSteps).where(and(
    eq(schema.dashboardJobSteps.organizationId, sql.placeholder("organizationId")),
    eq(schema.dashboardJobSteps.runId, sql.placeholder("runId")),
    sql`${schema.dashboardJobSteps.jobId} IN (SELECT j.id FROM ${schema.dashboardJobs} j JOIN ${schema.dashboardRuns} r ON r.organization_id=j.organization_id AND r.id=j.run_id WHERE j.organization_id=${sql.placeholder("organizationId")} AND j.run_id=${sql.placeholder("runId")} AND j.run_attempt=r.run_attempt)`,
  )).orderBy(asc(schema.dashboardJobSteps.jobId), asc(schema.dashboardJobSteps.number), asc(schema.dashboardJobSteps.id)).prepare("dashboard_run_detail_steps"),
  edges: db.select({ from: schema.dashboardActionEdges.fromJobId, to: schema.dashboardActionEdges.toJobId })
    .from(schema.dashboardActionEdges).where(and(
      eq(schema.dashboardActionEdges.organizationId, sql.placeholder("organizationId")),
      eq(schema.dashboardActionEdges.runId, sql.placeholder("runId")),
      sql`EXISTS (SELECT 1 FROM ${schema.dashboardJobs} source JOIN ${schema.dashboardRuns} r ON r.organization_id=source.organization_id AND r.id=source.run_id WHERE source.organization_id=${schema.dashboardActionEdges.organizationId} AND source.id=${schema.dashboardActionEdges.fromJobId} AND source.run_attempt=r.run_attempt)`,
      sql`EXISTS (SELECT 1 FROM ${schema.dashboardJobs} target JOIN ${schema.dashboardRuns} r ON r.organization_id=target.organization_id AND r.id=target.run_id WHERE target.organization_id=${schema.dashboardActionEdges.organizationId} AND target.id=${schema.dashboardActionEdges.toJobId} AND target.run_attempt=r.run_attempt)`,
    )).orderBy(asc(schema.dashboardActionEdges.fromJobId), asc(schema.dashboardActionEdges.toJobId)).prepare("dashboard_run_detail_edges"),
  stages: db.select({
    stage: schema.dashboardRunStages.stage,
    startedAt: schema.dashboardRunStages.startedAt,
    completedAt: schema.dashboardRunStages.completedAt,
    durationMs: sql<number>`COALESCE(EXTRACT(EPOCH FROM (${schema.dashboardRunStages.completedAt}-${schema.dashboardRunStages.startedAt}))*1000,0)::bigint`,
  }).from(schema.dashboardRunStages).where(and(eq(schema.dashboardRunStages.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRunStages.runId, sql.placeholder("runId"))))
    .orderBy(asc(schema.dashboardRunStages.startedAt)).prepare("dashboard_run_detail_stages"),
}));


export async function getRunDetail(db: DashboardDb, organizationId: string, runId: string): Promise<RunDetail | null> {
  const run = (await listRuns(db, organizationId, 1000)).items.find((item) => item.id === runId);
  if (!run) return null;
  const queryParams = { organizationId, runId };
  const jobRows = await runDetailQueries(db).jobs.execute(queryParams) as Record<string, unknown>[];
  const stepRows = await runDetailQueries(db).steps.execute(queryParams) as Record<string, unknown>[];
  const stepsByJob = new Map<string, RunJob["steps"]>();
  for (const row of stepRows) {
    const jobId = String(row.jobId);
    const durationMs = Number(row.durationMs);
    const step: RunJob["steps"][number] = {
      id: String(row.id),
      name: String(row.name),
      number: Number(row.number),
      status: row.status as RunJob["steps"][number]["status"],
      conclusion: row.conclusion == null ? null : String(row.conclusion),
      queuedAt: normalizeTimestamp(row.queuedAt)!,
      startedAt: normalizeTimestamp(row.startedAt),
      completedAt: normalizeTimestamp(row.completedAt),
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
    };
    const steps = stepsByJob.get(jobId);
    if (steps) steps.push(step);
    else stepsByJob.set(jobId, [step]);
  }
  const jobs = jobRows.map((row): RunJob => {
    const requestedLabels = jsonValue(row.requestedLabels);
    const terminal = jsonValue(row.terminalResult);
    const terminalObject = terminal && typeof terminal === "object" ? terminal as Record<string, unknown> : null;
    const oomCandidate = terminalObject?.oom;
    const oom = oomCandidate && typeof oomCandidate === "object" ? oomCandidate as RunJob["oom"] : null;
    const parsedTermination = RuntimeTerminationEvidence.safeParse(terminalObject?.termination);
    const termination = parsedTermination.success ? parsedTermination.data : null;
    const reason = terminalObject?.reason;
    const failureReason: RunJob["failureReason"] = reason === "out_of_memory" || oom || termination?.container?.oomKilled === true ? "out_of_memory"
      : reason === "worker_inventory_missing" || reason === "runner_lost" || termination?.cause === "child_disappeared" ? "runner_lost"
      : reason === "runner_failed" || typeof terminalObject?.exitCode === "number" && terminalObject.exitCode !== 0 ? "runner_failed" : null;
    return {
      id: String(row.id),
      name: String(row.name),
      status: row.status as RunJob["status"],
      conclusion: row.conclusion == null ? null : String(row.conclusion),
      stage: row.stage as RunJob["stage"],
      runnerName: row.runnerName == null ? null : String(row.runnerName),
      logsState: row.logsState as RunJob["logsState"],
      requested: jsonValue(row.requested) as RunJob["requested"],
      requestedLabels: Array.isArray(requestedLabels) ? requestedLabels.filter((label): label is string => typeof label === "string") : [],
      observed: row.observed == null ? null : jsonValue(row.observed) as RunJob["observed"],
      failureReason,
      oom,
      termination,
      steps: stepsByJob.get(String(row.id)) ?? [],
    };
  });
  const edges = await runDetailQueries(db).edges.execute(queryParams) as ActionGraph["edges"];
  const stageRows = await runDetailQueries(db).stages.execute(queryParams) as Record<string, unknown>[];
  const stages = stageRows.map((row): RunStageRecord => ({
    stage: row.stage as RunStageRecord["stage"],
    startedAt: normalizeTimestamp(row.startedAt)!,
    completedAt: normalizeTimestamp(row.completedAt),
    durationMs: Math.max(0, Number(row.durationMs) || 0),
  }));
  const runAttempt = run.runAttempt;
  const failureAnalysisRows = await runDetailQueries(db).failureAnalysis.execute({ ...queryParams, runAttempt }) as Record<string, unknown>[];
  const failureAnalysisEnabledRows = await runDetailQueries(db).failureAnalysisEnabled.execute({ organizationId, repositoryId: run.repositoryId }) as Record<string, unknown>[];
  const failureAnalysisRow = failureAnalysisRows[0];
  const failureAnalysisComments = failureAnalysisRow ? await runDetailQueries(db).failureAnalysisComments.execute({ analysisId: String(failureAnalysisRow.id) }) as Record<string, unknown>[] : [];
  const failureAnalysis: PipelineFailureAnalysis | null = failureAnalysisRow ? {
    id: String(failureAnalysisRow.id),
    runAttempt: Number(failureAnalysisRow.runAttempt),
    state: failureAnalysisRow.state as PipelineFailureAnalysis["state"],
    providerName: String(failureAnalysisRow.providerName),
    model: String(failureAnalysisRow.model),
    result: failureAnalysisRow.result == null ? null : failureAnalysisRow.result as PipelineFailureAnalysis["result"],
    errorCode: failureAnalysisRow.errorCode == null ? null : String(failureAnalysisRow.errorCode),
    metrics: analysisMetrics(failureAnalysisRow, Date.now()),
    comments: failureAnalysisComments.map((comment) => ({
      prNumber: Number(comment.prNumber),
      state: comment.state as PipelineFailureAnalysis["comments"][number]["state"],
      commentUrl: comment.commentUrl == null ? null : String(comment.commentUrl),
      commentBody: comment.commentBody == null ? null : String(comment.commentBody),
      errorCode: comment.errorCode == null ? null : String(comment.errorCode),
    })),
  } : null;
  return {
    ...run,
    jobs,
    stages,
    actionGraph: {
      nodes: jobs.map((job, index) => {
        const row = jobRows[index]!;
        const startedAt = normalizeTimestamp(row.startedAt);
        const completedAt = normalizeTimestamp(row.completedAt);
        return {
          id: job.id,
          name: job.name,
          status: job.stage,
          conclusion: job.conclusion,
          durationMs: derivedDurationMs(startedAt, completedAt, job.status),
        };
      }),
      edges,
    },
    failureAnalysis,
    failureAnalysisEnabled: failureAnalysisEnabledRows[0]?.enabled === true,
  };
}
const logQueries = defineQueries((db) => ({
  step: db.select({
    organizationId: schema.dashboardStepLogChunks.organizationId,
    runId: schema.dashboardStepLogChunks.runId,
    jobId: schema.dashboardStepLogChunks.jobId,
    sequence: schema.dashboardStepLogChunks.sequence,
    content: schema.dashboardStepLogChunks.content,
    hasMore: sql<boolean>`false`,
    occurredAt: schema.dashboardStepLogChunks.occurredAt,
  }).from(schema.dashboardStepLogChunks)
    .where(and(eq(schema.dashboardStepLogChunks.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardStepLogChunks.runId, sql.placeholder("runId")), eq(schema.dashboardStepLogChunks.jobId, sql.placeholder("jobId")), eq(schema.dashboardStepLogChunks.stepId, sql.placeholder("stepId")), gt(schema.dashboardStepLogChunks.sequence, sql.placeholder("after"))))
    .orderBy(asc(schema.dashboardStepLogChunks.sequence)).limit(sql.placeholder("limit")).prepare("dashboard_step_log_chunks"),
  job: db.select({
    organizationId: schema.dashboardLogChunks.organizationId,
    runId: schema.dashboardLogChunks.runId,
    jobId: schema.dashboardLogChunks.jobId,
    sequence: schema.dashboardLogChunks.sequence,
    content: schema.dashboardLogChunks.content,
    hasMore: sql<boolean>`false`,
    occurredAt: schema.dashboardLogChunks.occurredAt,
  }).from(schema.dashboardLogChunks)
    .where(and(eq(schema.dashboardLogChunks.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardLogChunks.runId, sql.placeholder("runId")), eq(schema.dashboardLogChunks.jobId, sql.placeholder("jobId")), gt(schema.dashboardLogChunks.sequence, sql.placeholder("after"))))
    .orderBy(asc(schema.dashboardLogChunks.sequence)).limit(sql.placeholder("limit")).prepare("dashboard_log_chunks"),
}));
const mapLogChunks = (rows: LogChunk[], limit: number) => ({
  items: rows.slice(0, limit).map((x) => ({ ...x, sequence: Number(x.sequence), hasMore: rows.length > limit, occurredAt: normalizeTimestamp(x.occurredAt)! })),
  nextCursor: rows.length > limit ? String(rows[limit - 1].sequence) : null,
});
export async function listStepLogChunks(db: DashboardDb, organizationId: string, runId: string, jobId: string, stepId: string, after = -1, limit = 100): Promise<CursorPage<LogChunk>> {
  const safeLimit = Math.max(0, Math.min(1000, Math.floor(limit)));
  if (safeLimit === 0) return { items: [], nextCursor: null };
  const rows = await logQueries(db).step.execute({ organizationId, runId, jobId, stepId, after, limit: safeLimit + 1 }) as LogChunk[];
  return mapLogChunks(rows, safeLimit);
}
export async function listLogChunks(db: DashboardDb, organizationId: string, runId: string, jobId: string, after = -1, limit = 100): Promise<CursorPage<LogChunk>> {
  const safeLimit = Math.max(0, Math.min(1000, Math.floor(limit)));
  if (safeLimit === 0) return { items: [], nextCursor: null };
  const rows = await logQueries(db).job.execute({ organizationId, runId, jobId, after, limit: safeLimit + 1 }) as LogChunk[];
  return mapLogChunks(rows, safeLimit);
}
function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function workerCapacity(value: unknown): WorkerDetail["capacity"] {
  const parsed = jsonValue(value);
  const wrapper = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const source = wrapper.capacity && typeof wrapper.capacity === "object" ? wrapper.capacity as Record<string, unknown> : wrapper;
  const metric = (name: string, fallbackActual: number) => {
    const raw = source[name];
    const object = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const actual = Math.max(1, numberValue(object.actual, fallbackActual));
    return { actual, reserved: Math.max(0, numberValue(object.reserved, 0)), free: Math.max(0, numberValue(object.free, actual)) };
  };
  const flat = (name: string, fallback: number) => numberValue(source[name], fallback);
  return CapacitySnapshot.parse({
    vcpu: source.vcpu ? metric("vcpu", 1) : { actual: Math.max(1, flat("actualVcpu", 1)), reserved: 0, free: Math.max(0, flat("freeVcpu", flat("actualVcpu", 1))) },
    memoryBytes: source.memoryBytes ? metric("memoryBytes", 1) : { actual: Math.max(1, flat("actualMemoryBytes", 1)), reserved: 0, free: Math.max(0, flat("freeMemoryBytes", flat("actualMemoryBytes", 1))) },
    storageBytes: source.storageBytes ? metric("storageBytes", 1) : { actual: Math.max(1, flat("actualStorageBytes", 1)), reserved: 0, free: Math.max(0, flat("freeStorageBytes", flat("actualStorageBytes", 1))) },
    pods: source.pods ? metric("pods", 1) : { actual: 1, reserved: 0, free: 1 },
  });
}
function workerDoctor(value: unknown): WorkerDetail["doctor"] {
  const parsed = jsonValue(value);
  const wrapper = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const nested = wrapper.doctor && typeof wrapper.doctor === "object" ? wrapper.doctor as Record<string, unknown> : {};
  const source = { ...nested, ...wrapper };
  if (!Object.keys(source).length) return null;
  const candidate: Record<string, unknown> = {};
  for (const key of ["nestedKvm", "kvmModules", "probe", "imageSignatures", "blockVolume", "runtimeReady", "preserveLeases", "acceptingLeases"]) {
    if (typeof source[key] === "boolean") candidate[key] = source[key];
  }
  if (["idle", "building", "ready", "failed"].includes(String(source.runtimeBuildState))) candidate.runtimeBuildState = source.runtimeBuildState;
  if (typeof source.runtimeBuildMessage === "string" || source.runtimeBuildMessage === null) candidate.runtimeBuildMessage = source.runtimeBuildMessage;
  if (["container", "vm", "tart"].includes(String(source.runtimeMode))) candidate.runtimeMode = source.runtimeMode;
  if (["worker_local", "registry", "template"].includes(String(source.artifactSource))) candidate.artifactSource = source.artifactSource;
  if (typeof source.artifactIdentity === "string") candidate.artifactIdentity = source.artifactIdentity;
  if (typeof source.artifactDigest === "string") candidate.artifactDigest = source.artifactDigest;
  if (source.artifactDigests && typeof source.artifactDigests === "object") candidate.artifactDigests = source.artifactDigests;
  if (typeof source.runtimeHandler === "string") candidate.runtimeHandler = source.runtimeHandler;
  if (typeof source.remediation === "string" || source.remediation === null) candidate.remediation = source.remediation;
  if (Array.isArray(source.capabilities)) candidate.capabilities = source.capabilities;
  const result = WorkerDoctor.safeParse(candidate);
  return result.success ? result.data : null;
}
function workerCache(row: Record<string, unknown>): WorkerCacheSummary {
  const desired = jsonValue(row.desiredConfiguration);
  const desiredObject = desired && typeof desired === "object" ? desired as Record<string, unknown> : {};
  const cache = desiredObject.cache && typeof desiredObject.cache === "object" ? desiredObject.cache as Record<string, unknown> : {};
  const runnerCacheObservedAt = row.runnerCacheObservedAt ?? row.cacheRunnerCacheObservedAt;
  return WorkerCacheSummary.parse({
    desiredTtlSeconds: Number(cache.ttlSeconds ?? 172800),
    desiredRunnerCacheEnabled: cache.runnerCacheEnabled !== false,
    desiredRunnerCacheMaxGiB: Number(cache.runnerCacheMaxGiB ?? 20),
    effectiveTtlSeconds: row.cacheTtlSeconds == null ? null : Number(row.cacheTtlSeconds),
    effectiveRunnerCacheEnabled: row.runnerCacheEnabled == null ? null : row.runnerCacheEnabled === true,
    effectiveRunnerCacheMaxGiB: row.runnerCacheMaxGiB == null ? null : Number(row.runnerCacheMaxGiB),
    ready: row.cacheReady === true,
    proxyOrigin: row.cacheProxyOrigin == null ? null : String(row.cacheProxyOrigin),
    cacheBaseUrl: row.cacheBaseUrl == null ? null : String(row.cacheBaseUrl),
    sizeBytes: row.cacheObservedAt == null ? null : String(row.cacheSizeBytes ?? "0"),
    entryCount: row.cacheObservedAt == null ? null : Number(row.cacheEntryCount ?? 0),
    runnerCacheSizeBytes: runnerCacheObservedAt == null ? null : String(row.runnerCacheSizeBytes ?? "0"),
    runnerCacheEntryCount: runnerCacheObservedAt == null ? null : Number(row.runnerCacheEntryCount ?? 0),
    observedAt: row.cacheObservedAt == null ? null : normalizeTimestamp(row.cacheObservedAt),
    runnerCacheObservedAt: runnerCacheObservedAt == null ? null : normalizeTimestamp(runnerCacheObservedAt),
    error: row.cacheError == null ? null : String(row.cacheError),
  });
}

function healthDecimal(value: unknown, fallback = "0"): string {
  if (typeof value === "bigint" && value >= 0n) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return fallback;
}
function addHealthDecimals(values: unknown[]): string {
  return values.reduce<bigint>((total, value) => total + BigInt(healthDecimal(value)), 0n).toString();
}
function healthNumber(value: unknown, fallback = 0): number {
  const candidate = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(candidate) || (Number.isFinite(candidate) && candidate >= 0) ? candidate : fallback;
}
function healthAge(value: unknown, startedAt: string | null, observedAt: string | null): number | null {
  if (value !== null && value !== undefined) return Math.max(0, Math.floor(healthNumber(value, 0)));
  if (!startedAt || !observedAt) return null;
  const age = (Date.parse(observedAt) - Date.parse(startedAt)) / 1000;
  return Number.isFinite(age) ? Math.max(0, Math.floor(age)) : null;
}
function healthCapacitySource(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  const wrapper = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const nested = wrapper.doctor && typeof wrapper.doctor === "object" ? wrapper.doctor as Record<string, unknown> : {};
  const capacity = wrapper.capacity && typeof wrapper.capacity === "object" ? wrapper.capacity : nested.capacity;
  return capacity && typeof capacity === "object" ? capacity as Record<string, unknown> : {};
}
function healthCapacityMetric(source: Record<string, unknown>, name: string, actualKey: string, freeKey: string, decimal = false) {
  const raw = source[name];
  const object = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (decimal) {
    const actual = healthDecimal(object.actual ?? source[actualKey]);
    const free = healthDecimal(object.free ?? source[freeKey], actual);
    return { actual, free };
  }
  const actual = healthNumber(object.actual ?? source[actualKey]);
  return { actual, free: healthNumber(object.free ?? source[freeKey], actual) };
}
function healthRequested(value: unknown): { vcpu: number; memoryBytes: string; storageBytes: string; concurrency: number } {
  const parsed = jsonValue(value);
  const request = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return { vcpu: healthNumber(request.vcpu), memoryBytes: healthDecimal(request.memoryBytes), storageBytes: healthDecimal(request.storageBytes), concurrency: healthNumber(request.concurrency) };
}
function healthJobId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const id = healthNumber(value, -1);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}
const workerHealthQueries = defineQueries((db) => ({
  worker: db.select({
    id: schema.workers.id,
    platform: schema.workers.platform,
    connectionState: schema.workers.connectionState,
    lastHeartbeatAt: schema.workers.lastHeartbeatAt,
    lastDoctorAt: schema.workers.doctorObservedAt,
    doctor: schema.workers.doctor,
    limits: schema.workers.limits,
    desiredConfiguration: schema.workers.desiredConfiguration,
    configurationState: schema.workers.configurationState,
    configurationFailureReason: sql<string | null>`CASE WHEN ${schema.workers.configurationState}='error' THEN (SELECT a.payload->>'reason' FROM ${schema.auditEvents} a WHERE a.type='worker.configuration_failed' AND a.payload->>'workerId'=${schema.workers.id}::text AND a.payload->>'commandId'=${schema.workers.configurationCommandId}::text AND a.payload->>'revision'=${schema.workers.configurationRevision} ORDER BY a.created_at DESC LIMIT 1) ELSE NULL END`,
    observedAt: sql<Date>`now()`,
    heartbeatAgeSeconds: sql<number>`GREATEST(0,EXTRACT(EPOCH FROM (now()-${schema.workers.lastHeartbeatAt})))::int`,
    doctorAgeSeconds: sql<number>`GREATEST(0,EXTRACT(EPOCH FROM (now()-${schema.workers.doctorObservedAt})))::int`,
    cacheGeneration: schema.workerCacheStatus.generation,
    cacheReady: schema.workerCacheStatus.ready,
    cacheTtlSeconds: schema.workerCacheStatus.ttlSeconds,
    cacheSizeBytes: sql<string | null>`${schema.workerCacheStatus.sizeBytes}::text`,
    cacheEntryCount: schema.workerCacheStatus.entryCount,
    runnerCacheEnabled: schema.workerCacheStatus.runnerCacheEnabled,
    runnerCacheMaxGiB: schema.workerCacheStatus.runnerCacheMaxGiB,
    runnerCacheSizeBytes: sql<string | null>`${schema.workerCacheStatus.runnerCacheSizeBytes}::text`,
    runnerCacheEntryCount: schema.workerCacheStatus.runnerCacheEntryCount,
    cacheObservedAt: schema.workerCacheStatus.observedAt,
    runnerCacheObservedAt: schema.workerCacheStatus.runnerCacheObservedAt,
    cacheError: schema.workerCacheStatus.error,
  }).from(schema.workers).leftJoin(schema.workerCacheStatus, eq(schema.workerCacheStatus.workerId, schema.workers.id))
    .where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("dashboard_get_worker_health"),
  leases: db.select({
    leaseId: schema.runnerLeases.id,
    jobId: schema.runnerLeases.githubJobId,
    repositoryFullName: schema.dashboardRepositories.fullName,
    repositoryName: schema.dashboardRepositories.name,
    state: schema.runnerLeases.state,
    startedAt: sql<Date>`COALESCE(${schema.runnerLeases.updatedAt},${schema.runnerLeases.createdAt})`,
    ageSeconds: sql<number>`GREATEST(0,EXTRACT(EPOCH FROM (now()-COALESCE(${schema.runnerLeases.updatedAt},${schema.runnerLeases.createdAt}))))::int`,
    requested: schema.runnerLeases.requested,
    sampleCpuUsagePercent: sql<number | null>`(SELECT s.cpu_usage_percent FROM ${schema.dashboardJobResourceSamples} s JOIN ${schema.dashboardJobs} j ON j.organization_id=s.organization_id AND j.id=s.job_id WHERE j.github_job_id=${schema.runnerLeases.githubJobId} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    sampleMemoryWorkingSetBytes: sql<string | null>`(SELECT s.memory_working_set_bytes::text FROM ${schema.dashboardJobResourceSamples} s JOIN ${schema.dashboardJobs} j ON j.organization_id=s.organization_id AND j.id=s.job_id WHERE j.github_job_id=${schema.runnerLeases.githubJobId} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    sampleMemoryLimitBytes: sql<string | null>`(SELECT s.memory_limit_bytes::text FROM ${schema.dashboardJobResourceSamples} s JOIN ${schema.dashboardJobs} j ON j.organization_id=s.organization_id AND j.id=s.job_id WHERE j.github_job_id=${schema.runnerLeases.githubJobId} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    sampleDiskUsageBytes: sql<string | null>`(SELECT s.disk_usage_bytes::text FROM ${schema.dashboardJobResourceSamples} s JOIN ${schema.dashboardJobs} j ON j.organization_id=s.organization_id AND j.id=s.job_id WHERE j.github_job_id=${schema.runnerLeases.githubJobId} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
    sampledAt: sql<Date | null>`(SELECT s.occurred_at FROM ${schema.dashboardJobResourceSamples} s JOIN ${schema.dashboardJobs} j ON j.organization_id=s.organization_id AND j.id=s.job_id WHERE j.github_job_id=${schema.runnerLeases.githubJobId} AND s.lease_id=${schema.runnerLeases.id} ORDER BY s.occurred_at DESC LIMIT 1)`,
  }).from(schema.runnerLeases)
    .leftJoin(schema.dashboardJobs, eq(schema.dashboardJobs.githubJobId, schema.runnerLeases.githubJobId))
    .leftJoin(schema.dashboardRuns, eq(schema.dashboardRuns.id, schema.dashboardJobs.runId))
    .leftJoin(schema.dashboardRepositories, eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId))
    .where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), sql`${schema.runnerLeases.state} IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`))
    .orderBy(asc(schema.runnerLeases.createdAt), asc(schema.runnerLeases.id)).prepare("dashboard_worker_health_leases"),
}));

function healthContainers(value: unknown): WorkerHealth["containers"] {
  const parsed = jsonValue(value);
  const wrapper = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const doctor = wrapper.doctor && typeof wrapper.doctor === "object" ? wrapper.doctor as Record<string, unknown> : wrapper;
  if (!Array.isArray(doctor.containers)) return [];
  const containers: WorkerHealth["containers"] = [];
  for (const candidate of doctor.containers) {
    const parsedContainer = WorkerContainerStatus.safeParse(candidate);
    if (!parsedContainer.success) continue;
    const container = parsedContainer.data;
    containers.push({
      ...container,
      memoryWorkingSetBytes: container.memoryWorkingSetBytes === null ? null : String(container.memoryWorkingSetBytes),
      memoryLimitBytes: container.memoryLimitBytes === null ? null : String(container.memoryLimitBytes),
      diskUsageBytes: container.diskUsageBytes === null ? null : String(container.diskUsageBytes),
    });
  }
  return containers.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.containerId < right.containerId ? -1 : left.containerId > right.containerId ? 1 : 0);
}


export async function getWorkerHealth(db: DashboardDb, workerId: string, workerConnected: (workerId: string) => boolean): Promise<WorkerHealth | null> {
  const [worker] = await workerHealthQueries(db).worker.execute({ workerId }) as Record<string, unknown>[];
  if (!worker) return null;
  const observedAt = normalizeTimestamp(worker.observedAt);
  const capacity = healthCapacitySource(worker.doctor);
  const leases = await workerHealthQueries(db).leases.execute({ workerId }) as Record<string, unknown>[];
  const requests = leases.map((row) => healthRequested(row.requested));
  const actualCpu = healthCapacityMetric(capacity, "vcpu", "actualVcpu", "actualVcpu").actual;
  const freeCpu = healthCapacityMetric(capacity, "vcpu", "freeVcpu", "freeVcpu").free;
  const actualMemory = healthCapacityMetric(capacity, "memoryBytes", "actualMemoryBytes", "actualMemoryBytes", true);
  const freeMemory = healthCapacityMetric(capacity, "memoryBytes", "freeMemoryBytes", "freeMemoryBytes", true);
  const actualStorage = healthCapacityMetric(capacity, "storageBytes", "actualStorageBytes", "actualStorageBytes", true);
  const freeStorage = healthCapacityMetric(capacity, "storageBytes", "freeStorageBytes", "freeStorageBytes", true);
  const limits = jsonValue(worker.limits);
  const limitsObject = limits && typeof limits === "object" ? limits as Record<string, unknown> : {};
  const actualPods = healthNumber(limitsObject.maxConcurrentPods, requests.length);
  const reservedPods = requests.length;
  const freePods = Math.max(0, actualPods - reservedPods);
  const desired = jsonValue(worker.desiredConfiguration);
  const desiredObject = desired && typeof desired === "object" ? desired as Record<string, unknown> : {};
  const desiredCache = desiredObject.cache && typeof desiredObject.cache === "object" ? desiredObject.cache as Record<string, unknown> : {};
  const doctor = workerDoctor(worker.doctor);
  const storedDoctor = jsonValue(worker.doctor);
  const disconnectValue = storedDoctor && typeof storedDoctor === "object" && "lastDisconnect" in storedDoctor ? storedDoctor.lastDisconnect : undefined;
  const disconnect = WorkerDisconnectEvidence.safeParse(disconnectValue);
  return WorkerHealth.parse({
    observedAt,
    runtimeMode: doctor?.runtimeMode ?? (String(worker.platform) === "macos-arm64" ? "tart" : null),
    configuration: {
      state: ConfigurationState.parse(worker.configurationState),
      failureReason: typeof worker.configurationFailureReason === "string" ? worker.configurationFailureReason : null,
    },
    connection: {
      state: workerConnected(workerId) ? "online" : "offline",
      lastHeartbeatAt: normalizeTimestamp(worker.lastHeartbeatAt),
      lastDoctorAt: normalizeTimestamp(worker.lastDoctorAt),
      heartbeatAgeSeconds: healthAge(worker.heartbeatAgeSeconds, normalizeTimestamp(worker.lastHeartbeatAt), observedAt),
      doctorAgeSeconds: healthAge(worker.doctorAgeSeconds, normalizeTimestamp(worker.lastDoctorAt), observedAt),
      ...(disconnect.success && disconnect.data ? { lastDisconnect: disconnect.data } : {}),
    },
    usage: {
      cpu: { actual: actualCpu, reserved: requests.reduce((sum, request) => sum + request.vcpu, 0), free: freeCpu },
      memoryBytes: { actual: actualMemory.actual, reserved: addHealthDecimals(requests.map((request) => request.memoryBytes)), free: freeMemory.free },
      storageBytes: { actual: actualStorage.actual, reserved: addHealthDecimals(requests.map((request) => request.storageBytes)), free: freeStorage.free },
      pods: { actual: actualPods, reserved: reservedPods, free: freePods },
    },
    cache: {
      desiredTtlSeconds: healthNumber(desiredCache.ttlSeconds, 172800),
      effectiveTtlSeconds: worker.cacheTtlSeconds == null ? null : healthNumber(worker.cacheTtlSeconds),
      effectiveRunnerCacheEnabled: worker.runnerCacheEnabled == null ? null : worker.runnerCacheEnabled === true,
      effectiveRunnerCacheMaxGiB: worker.runnerCacheMaxGiB == null ? null : healthNumber(worker.runnerCacheMaxGiB),
      ready: worker.cacheReady === true,
      generation: typeof worker.cacheGeneration === "string" ? worker.cacheGeneration : null,
      sizeBytes: worker.cacheObservedAt == null ? null : healthDecimal(worker.cacheSizeBytes),
      entryCount: worker.cacheObservedAt == null ? null : healthNumber(worker.cacheEntryCount),
      runnerCacheSizeBytes: worker.runnerCacheObservedAt == null ? null : healthDecimal(worker.runnerCacheSizeBytes),
      runnerCacheEntryCount: worker.runnerCacheObservedAt == null ? null : healthNumber(worker.runnerCacheEntryCount),
      observedAt: normalizeTimestamp(worker.cacheObservedAt),
      runnerCacheObservedAt: normalizeTimestamp(worker.runnerCacheObservedAt),
      error: worker.cacheError == null ? null : String(worker.cacheError),
    },
    containers: healthContainers(worker.doctor),
    jobs: leases.map((row, index) => {
      const startedAt = normalizeTimestamp(row.startedAt);
      return {
        jobId: healthJobId(row.jobId),
        repositoryFullName: row.repositoryFullName == null ? null : String(row.repositoryFullName),
        repositoryName: row.repositoryName == null ? null : String(row.repositoryName),
        leaseId: String(row.leaseId),
        state: String(row.state),
        startedAt,
        ageSeconds: healthAge(row.ageSeconds, startedAt, observedAt),
        requested: requests[index]!,
        sample: row.sampledAt == null ? null : {
          cpuUsagePercent: Number(row.sampleCpuUsagePercent),
          memoryWorkingSetBytes: healthDecimal(row.sampleMemoryWorkingSetBytes),
          memoryLimitBytes: healthDecimal(row.sampleMemoryLimitBytes),
          diskUsageBytes: row.sampleDiskUsageBytes == null ? null : healthDecimal(row.sampleDiskUsageBytes),
          sampledAt: normalizeTimestamp(row.sampledAt),
        },
      };
    }),
  });
}
function normalizeWorker(row: Record<string, unknown>, workerConnected?: (workerId: string) => boolean): WorkerDetail {
  const platform = RuntimePlatform.parse(row.platform);
  const rawGuestPlatforms = jsonValue(row.guestPlatforms);
  const guestPlatforms = Array.isArray(rawGuestPlatforms) && rawGuestPlatforms.length > 0 ? rawGuestPlatforms.map((value) => GuestPlatform.parse(value)) : [platform];
  const limitsValue = WorkerLimits.safeParse(jsonValue(row.limits));
  const doctor = workerDoctor(row.doctor);
  const desired = jsonValue(row.desiredConfiguration);
  const desiredConfiguration = desired && typeof desired === "object" ? desired as Record<string, unknown> : {};
  const selectedDriver = RuntimeDriverName.safeParse(desiredConfiguration.selectedDriver);
  const driver = selectedDriver.success ? selectedDriver.data : null;
  const timestamp = (value: unknown) => {
    const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  const worker: WorkerDetail = {
    id: String(row.id),
    organizationId: typeof row.organizationId === "string" ? row.organizationId : null,
    name: String(row.name),
    platform,
    guestPlatforms,
    releaseVersion: typeof row.releaseVersion === "string" ? row.releaseVersion : null,
    contractVersion: typeof row.contractVersion === "string" ? row.contractVersion : null,
    driver,
    selectedDriver: driver,
    admissionState: WorkerState.parse(row.admissionState),
    connectionState: workerConnected ? (workerConnected(String(row.id)) ? "online" : "offline") : ConnectionState.parse(row.connectionState),
    configurationState: ConfigurationState.parse(row.configurationState),
    configurationRevision: typeof row.configurationRevision === "string" ? row.configurationRevision : null,
    appliedConfigurationRevision: typeof row.appliedConfigurationRevision === "string" ? row.appliedConfigurationRevision : null,
    configurationAppliedAt: timestamp(row.configurationAppliedAt),
    lastHeartbeatAt: timestamp(row.lastHeartbeatAt),
    lastDoctorAt: timestamp(row.lastDoctorAt),
    runtimeMode: doctor?.runtimeMode ?? (platform === "macos-arm64" ? "tart" : null),
    artifactDigest: doctor?.artifactDigest ?? null,
    artifactDigests: doctor?.artifactDigests ?? null,
    fingerprint: String(row.fingerprint),
    limits: limitsValue.success ? limitsValue.data : null,
    doctor,
    capacity: workerCapacity(row.doctor),
    activeSandboxes: numberValue(row.activeSandboxes, 0),
    draining: row.draining === true,
    preserveLeases: row.preserveLeases === true,
    cache: workerCache(row),
  };
  return worker;
}
const workerProjection = () => ({
  id: schema.workers.id,
  organizationId: sql<string | null>`NULL::uuid`,
  name: schema.workers.name,
  platform: schema.workers.platform,
  releaseVersion: schema.workers.releaseVersion,
  contractVersion: schema.workers.contractVersion,
  guestPlatforms: schema.workers.guestPlatforms,
  admissionState: schema.workers.admissionState,
  connectionState: schema.workers.connectionState,
  configurationState: schema.workers.configurationState,
  configurationRevision: schema.workers.configurationRevision,
  appliedConfigurationRevision: schema.workers.appliedConfigurationRevision,
  configurationAppliedAt: schema.workers.configurationAppliedAt,
  lastHeartbeatAt: schema.workers.lastHeartbeatAt,
  lastDoctorAt: schema.workers.doctorObservedAt,
  fingerprint: schema.workers.fingerprint,
  limits: schema.workers.limits,
  doctor: schema.workers.doctor,
  desiredConfiguration: schema.workers.desiredConfiguration,
  preserveLeases: schema.workers.preserveLeases,
  cacheTtlSeconds: schema.workerCacheStatus.ttlSeconds,
  cacheReady: schema.workerCacheStatus.ready,
  cacheProxyOrigin: schema.workerCacheStatus.proxyOrigin,
  cacheBaseUrl: schema.workerCacheStatus.cacheBaseUrl,
  cacheSizeBytes: schema.workerCacheStatus.sizeBytes,
  cacheEntryCount: schema.workerCacheStatus.entryCount,
  runnerCacheEnabled: schema.workerCacheStatus.runnerCacheEnabled,
  runnerCacheMaxGiB: schema.workerCacheStatus.runnerCacheMaxGiB,
  runnerCacheSizeBytes: schema.workerCacheStatus.runnerCacheSizeBytes,
  runnerCacheEntryCount: schema.workerCacheStatus.runnerCacheEntryCount,
  cacheObservedAt: schema.workerCacheStatus.observedAt,
  cacheRunnerCacheObservedAt: schema.workerCacheStatus.runnerCacheObservedAt,
  cacheError: schema.workerCacheStatus.error,
  activeSandboxes: sql<number>`(SELECT count(*)::int FROM ${schema.runnerLeases} l WHERE l.worker_id=${schema.workers.id} AND l.state NOT IN ('completed','reaped','failed','expired'))`,
  draining: schema.workers.draining,
});
const workerQueries = defineQueries((db) => ({
  organization: db.select(workerProjection()).from(schema.workers).leftJoin(schema.workerCacheStatus, eq(schema.workerCacheStatus.workerId, schema.workers.id))
    .where(inArray(schema.workers.id, db.select({ workerId: schema.runnerPools.workerId }).from(schema.runnerPools).where(eq(schema.runnerPools.organizationId, sql.placeholder("organizationId")))))
    .orderBy(asc(schema.workers.name)).limit(sql.placeholder("limit")).prepare("dashboard_list_workers"),
  all: db.select(workerProjection()).from(schema.workers).leftJoin(schema.workerCacheStatus, eq(schema.workerCacheStatus.workerId, schema.workers.id))
    .where(sql`(${sql.placeholder("includeInactive")} OR ${schema.workers.admissionState} NOT IN ('rejected','revoked'))`)
    .orderBy(asc(schema.workers.name)).limit(sql.placeholder("limit")).prepare("dashboard_list_all_workers"),
}));
export async function listWorkers(db: DashboardDb, organizationId: string, limit = 50, workerConnected?: (workerId: string) => boolean): Promise<CursorPage<WorkerDetail>> {
  const rows = await workerQueries(db).organization.execute({ organizationId, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(row => normalizeWorker(row, workerConnected));
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
export async function listAllWorkers(db: DashboardDb, userId: string, limit = 50, includeInactive = false, workerConnected?: (workerId: string) => boolean): Promise<CursorPage<WorkerDetail>> {
  const rows = await workerQueries(db).all.execute({ includeInactive, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(row => normalizeWorker(row, workerConnected));
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
export async function getWorkerDetail(db: DashboardDb, organizationId: string, workerId: string, workerConnected?: (workerId: string) => boolean): Promise<WorkerDetail | null> { const page = organizationId === "all" ? await listAllWorkers(db, "", 1000, true, workerConnected) : await listWorkers(db, organizationId, 1000, workerConnected); return page.items.find(worker => worker.id === workerId) ?? null; }
const mutationQueries = defineQueries((db) => ({
  transition: db.update(schema.dashboardRuns).set({
    status: sql`${sql.placeholder("status")}`,
    conclusion: sql`${sql.placeholder("conclusion")}`,
    startedAt: sql`COALESCE(${sql.placeholder("startedAt")}, ${schema.dashboardRuns.startedAt})`,
    completedAt: sql`COALESCE(${sql.placeholder("completedAt")}, ${schema.dashboardRuns.completedAt})`,
  }).where(and(eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.id, sql.placeholder("runId")), sql`${schema.dashboardRuns.status} <> 'completed'`, or(eq(schema.dashboardRuns.status, "queued"), sql`${sql.placeholder("status")} <> 'queued'`))).prepare("dashboard_record_run_transition"),
  stage: db.insert(schema.dashboardRunStages).values({
    organizationId: sql.placeholder("organizationId"),
    runId: sql.placeholder("runId"),
    stage: sql.placeholder("stage"),
  }).onConflictDoNothing().prepare("dashboard_record_run_stage"),
  mutation: db.insert(schema.dashboardMutations).values({
    organizationId: sql.placeholder("organizationId"),
    idempotencyKey: sql.placeholder("key"),
  }).onConflictDoNothing().returning({ idempotencyKey: schema.dashboardMutations.idempotencyKey }).prepare("dashboard_mutation"),
  invalidate: db.insert(schema.dashboardOutboxInvalidations).select(
    db.select({
      id: sql<string>`gen_random_uuid()`.as("id"),
      organizationId: sql<string>`(${sql.placeholder("organizationId")}::uuid)`.as("organization_id"),
      sequence: sql<number>`COALESCE(MAX(${schema.dashboardOutboxInvalidations.sequence}),0)+1`.as("sequence"),
      keys: sql`${sql.placeholder("keys")}::jsonb`.as("keys"),
      occurredAt: sql<string>`now()`.as("occurred_at"),
    }).from(schema.dashboardOutboxInvalidations).where(eq(schema.dashboardOutboxInvalidations.organizationId, sql.placeholder("organizationId"))),
  ).prepare("dashboard_invalidate"),
  recheckRepository: db.select({
    paused: sql<boolean>`${schema.dashboardRepositories.discoveryError} IN ('github_403','github_rate_limited') AND ${schema.dashboardRepositories.discoveryRetryAt}>now()`,
  }).from(schema.dashboardRepositories)
    .innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId), eq(schema.dashboardInstallations.organizationId, schema.dashboardRepositories.organizationId)))
    .where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.id, sql.placeholder("repositoryId")), eq(schema.dashboardRepositories.available, true), eq(schema.dashboardInstallations.state, "approved")))
    .for("update", { of: schema.dashboardRepositories }).prepare("dashboard_repository_recheck_lock"),
  priorMutation: db.select({ idempotencyKey: schema.dashboardMutations.idempotencyKey }).from(schema.dashboardMutations)
    .where(and(eq(schema.dashboardMutations.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardMutations.idempotencyKey, sql.placeholder("key"))))
    .limit(1).prepare("dashboard_repository_recheck_prior"),
  markRepository: db.update(schema.dashboardRepositories).set({ discoveryRetryAt: sql`now()` })
    .where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.id, sql.placeholder("repositoryId"))))
    .prepare("dashboard_repository_recheck_update"),
}));
export async function recordRunTransition(db: DashboardDb, organizationId: string, runId: string, transition: RunTransition): Promise<void> {
  await mutationQueries(db).transition.execute({ organizationId, runId, status: transition.status, conclusion: transition.conclusion, startedAt: transition.startedAt ?? null, completedAt: transition.completedAt ?? null });
}
const poolQueries = defineQueries((db) => ({
  organization: db.select({
    id: schema.runnerPools.id,
    organizationId: schema.runnerPools.organizationId,
    workerId: schema.runnerPools.workerId,
    workerName: schema.workers.name,
    name: schema.runnerPools.name,
    platform: schema.runnerPools.platform,
    driver: schema.runnerPools.driver,
    imageDigest: schema.runnerPools.imageDigest,
    resources: schema.runnerPools.resources,
    cpuMode: schema.runnerPools.cpuMode,
    labels: schema.runnerPools.labels,
    triggerLabel: schema.runnerPools.triggerLabel,
    enabled: schema.runnerPools.enabled,
    active: sql<number>`0`,
  }).from(schema.runnerPools).innerJoin(schema.workers, eq(schema.workers.id, schema.runnerPools.workerId))
    .where(eq(schema.runnerPools.organizationId, sql.placeholder("organizationId"))).orderBy(asc(schema.runnerPools.name))
    .limit(sql.placeholder("limit")).prepare("dashboard_list_pools"),
  global: db.select({
    id: schema.runnerPools.id,
    organizationId: sql<string | null>`NULL::uuid`,
    workerId: sql<string | null>`NULL::uuid`,
    workerName: sql<string>`'Shared fleet'`,
    name: schema.runnerPools.name,
    platform: schema.runnerPools.platform,
    driver: schema.runnerPools.driver,
    imageDigest: schema.runnerPools.imageDigest,
    resources: schema.runnerPools.resources,
    cpuMode: schema.runnerPools.cpuMode,
    labels: schema.runnerPools.labels,
    triggerLabel: schema.runnerPools.triggerLabel,
    enabled: schema.runnerPools.enabled,
    active: sql<number>`(${db.select({ count: sql<number>`count(*)::int` }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.poolId, schema.runnerPools.id), notInArray(schema.runnerLeases.state, ["completed", "reaped", "failed", "expired"])))})`,
  }).from(schema.runnerPools)
    .where(and(isNull(schema.runnerPools.organizationId), or(sql`${sql.placeholder("cursor")}::uuid IS NULL`, lt(schema.runnerPools.id, sql.placeholder("cursor")))))
    .orderBy(desc(schema.runnerPools.id)).limit(sql.placeholder("limit")).prepare("dashboard_list_global_pools"),
  all: db.select({
    id: schema.runnerPools.id,
    organizationId: schema.runnerPools.organizationId,
    workerId: schema.runnerPools.workerId,
    workerName: schema.workers.name,
    name: schema.runnerPools.name,
    platform: schema.runnerPools.platform,
    driver: schema.runnerPools.driver,
    imageDigest: schema.runnerPools.imageDigest,
    resources: schema.runnerPools.resources,
    cpuMode: schema.runnerPools.cpuMode,
    labels: schema.runnerPools.labels,
    triggerLabel: schema.runnerPools.triggerLabel,
    enabled: schema.runnerPools.enabled,
    active: sql<number>`0`,
  }).from(schema.runnerPools).innerJoin(schema.memberships, and(eq(schema.memberships.organizationId, schema.runnerPools.organizationId), eq(schema.memberships.userId, sql.placeholder("userId"))))
    .innerJoin(schema.workers, eq(schema.workers.id, schema.runnerPools.workerId)).orderBy(asc(schema.runnerPools.name))
    .limit(sql.placeholder("limit")).prepare("dashboard_list_all_pools"),
}));
export async function recordRunStage(db: DashboardDb, organizationId: string, runId: string, stage: RunStage): Promise<void> {
  await mutationQueries(db).stage.execute({ organizationId, runId, stage });
}
export async function dashboardMutation(db: DashboardDb, organizationId: string, key: string): Promise<boolean> {
  const rows = await mutationQueries(db).mutation.execute({ organizationId, key });
  return rows.length > 0;
}
export async function invalidateDashboard(db: DashboardDb, organizationId: string, keys: string[]): Promise<void> {
  await mutationQueries(db).invalidate.execute({ organizationId, keys: JSON.stringify(keys) });
}
function normalizePool(row: Record<string, unknown>): PoolSummary { return PoolSummary.parse({ ...row, resources: jsonValue(row.resources), labels: jsonValue(row.labels), active: numberValue(row.active, 0) }); }
export async function listPools(db: DashboardDb, organizationId: string, limit = 50): Promise<CursorPage<PoolSummary>> {
  const rows = await poolQueries(db).organization.execute({ organizationId, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizePool);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
export async function listGlobalPools(db: DashboardDb, limit = 50, cursor: string | null = null): Promise<CursorPage<PoolSummary>> {
  const rows = await poolQueries(db).global.execute({ cursor, limit: limit + 1 }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizePool);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}

export type QueueRepositoryDiscoveryRecheckResult = "queued" | "not_found" | "not_paused";

export async function queueRepositoryDiscoveryRecheck(
  db: DashboardDb,
  organizationId: string,
  repositoryId: string,
  idempotencyKey: string,
): Promise<QueueRepositoryDiscoveryRecheckResult> {
  const mutationKey = `repository-discovery-recheck:${repositoryId}:${idempotencyKey}`;
  return db.transaction(async (tx) => {
    const [repository] = await mutationQueries(tx).recheckRepository.execute({ organizationId, repositoryId });
    const [prior] = await mutationQueries(tx).priorMutation.execute({ organizationId, key: mutationKey });
    if (prior) return "queued";
    if (!repository) return "not_found";
    if (repository.paused !== true) return "not_paused";

    const inserted = await mutationQueries(tx).mutation.execute({ organizationId, key: mutationKey });
    if (!inserted.length) return "queued";

    await mutationQueries(tx).markRepository.execute({ organizationId, repositoryId });
    return "queued";
  });
}
