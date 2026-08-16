import type { Sql } from "postgres";
import { CapacitySnapshot, PoolSummary, RuntimeDriverName, RuntimePlatform, WorkerDoctor, WorkerLimits, GuestPlatform } from "@whitesmith/contracts";
import type { ActionGraph, CursorPage, LogChunk, OrganizationSummary, OverviewDto, OverviewTimeseriesPoint, RepositorySummary, RunDetail, RunJob, RunStage, RunStageRecord, RunSummary, WorkerDetail, OrganizationSettings } from "@whitesmith/contracts";
export type DashboardDb = Sql<{}>;
export type RunTransition = { status: RunSummary["status"]; conclusion: RunSummary["conclusion"]; startedAt?: string | null; completedAt?: string | null };
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

export async function listOrganizations(db: DashboardDb, userId: string): Promise<OrganizationSummary[]> {
  return await db<OrganizationSummary[]>`SELECT o.id, o.login AS name, o.login, m.role, (SELECT count(*)::int FROM dashboard_repositories r WHERE r.organization_id=o.id) AS "repositoryCount", (SELECT count(DISTINCT p.worker_id)::int FROM runner_pools p WHERE p.organization_id=o.id) AS "workerCount" FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=${userId} ORDER BY o.login`;
}
function normalizeOverviewTimeseries(rows: Array<Record<string, unknown>>): OverviewTimeseriesPoint[] {
  return rows.map((row) => {
    const raw = row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket);
    return { bucket: Number.isNaN(Date.parse(raw)) ? new Date().toISOString() : raw, pending: Number(row.pending ?? 0), running: Number(row.running ?? 0) };
  });
}

async function getOverviewTimeseries(db: DashboardDb, period: OverviewDto["period"], organizationId: string, userId?: string): Promise<OverviewTimeseriesPoint[]> {
  const membership = userId
    ? db<Record<string, unknown>[]>`WITH buckets AS (SELECT generate_series(date_trunc(CASE ${period} WHEN '24h' THEN 'hour' ELSE 'day' END, now() - CASE ${period} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END), date_trunc(CASE ${period} WHEN '24h' THEN 'hour' ELSE 'day' END, now()), CASE ${period} WHEN '24h' THEN interval '1 hour' ELSE interval '1 day' END) AS bucket), jobs AS (SELECT j.* FROM dashboard_jobs j JOIN dashboard_runs r ON r.id=j.run_id JOIN memberships m ON m.organization_id=j.organization_id AND m.user_id=${userId}) SELECT b.bucket,count(j.id) FILTER (WHERE j.queued_at<=b.bucket AND (j.started_at IS NULL OR j.started_at>b.bucket) AND (j.completed_at IS NULL OR j.completed_at>b.bucket))::int AS pending,count(j.id) FILTER (WHERE j.started_at IS NOT NULL AND j.started_at<=b.bucket AND (j.completed_at IS NULL OR j.completed_at>b.bucket))::int AS running FROM buckets b LEFT JOIN jobs j ON true GROUP BY b.bucket ORDER BY b.bucket`
    : db<Record<string, unknown>[]>`WITH buckets AS (SELECT generate_series(date_trunc(CASE ${period} WHEN '24h' THEN 'hour' ELSE 'day' END, now() - CASE ${period} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END), date_trunc(CASE ${period} WHEN '24h' THEN 'hour' ELSE 'day' END, now()), CASE ${period} WHEN '24h' THEN interval '1 hour' ELSE interval '1 day' END) AS bucket), jobs AS (SELECT * FROM dashboard_jobs WHERE organization_id=${organizationId}) SELECT b.bucket,count(j.id) FILTER (WHERE j.queued_at<=b.bucket AND (j.started_at IS NULL OR j.started_at>b.bucket) AND (j.completed_at IS NULL OR j.completed_at>b.bucket))::int AS pending,count(j.id) FILTER (WHERE j.started_at IS NOT NULL AND j.started_at<=b.bucket AND (j.completed_at IS NULL OR j.completed_at>b.bucket))::int AS running FROM buckets b LEFT JOIN jobs j ON true GROUP BY b.bucket ORDER BY b.bucket`;
  const rows = await membership;
  const currentRows = userId
    ? await db<Record<string, unknown>[]>`SELECT now() AS bucket, count(*) FILTER (WHERE j.status='queued')::int AS pending, count(*) FILTER (WHERE j.status='in_progress')::int AS running FROM dashboard_jobs j JOIN memberships m ON m.organization_id=j.organization_id AND m.user_id=${userId}`
    : await db<Record<string, unknown>[]>`SELECT now() AS bucket, count(*) FILTER (WHERE status='queued')::int AS pending, count(*) FILTER (WHERE status='in_progress')::int AS running FROM dashboard_jobs WHERE organization_id=${organizationId}`;
  const current = currentRows[0];
  const currentIsReal = current && (current.bucket instanceof Date || (typeof current.bucket === "string" && !Number.isNaN(Date.parse(current.bucket))));
  return normalizeOverviewTimeseries([...rows, ...(currentIsReal ? [current] : [])]);
}
type OverviewJobOutcome = NonNullable<OverviewDto["jobOutcomes"]>[number];
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
async function getOverviewJobOutcomes(db: DashboardDb, organizationId: string, period: OverviewDto["period"], userId?: string): Promise<OverviewJobOutcome[]> {
  const rows = userId
    ? await db<Record<string, unknown>[]>`SELECT CASE WHEN j.status='queued' THEN 'queued' WHEN j.status='in_progress' THEN 'running' ELSE CASE WHEN j.conclusion='success' THEN 'completed' ELSE 'failed' END END AS outcome, CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.requested_labels)='array' THEN j.requested_labels ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%macos%') THEN 'macos' WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.requested_labels)='array' THEN j.requested_labels ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%ubuntu%' OR lower(label) LIKE '%linux%') THEN 'ubuntu' WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.requested_labels)='array' THEN j.requested_labels ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%windows%') THEN 'windows' ELSE 'other' END AS platform, count(*)::int AS count FROM dashboard_jobs j JOIN memberships m ON m.organization_id=j.organization_id AND m.user_id=${userId} WHERE (j.status IN ('queued','in_progress') OR j.queued_at >= now() - ${periodSql(period)}::interval) GROUP BY outcome, platform`
    : await db<Record<string, unknown>[]>`SELECT CASE WHEN status='queued' THEN 'queued' WHEN status='in_progress' THEN 'running' ELSE CASE WHEN conclusion='success' THEN 'completed' ELSE 'failed' END END AS outcome, CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(requested_labels)='array' THEN requested_labels ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%macos%') THEN 'macos' WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(requested_labels)='array' THEN requested_labels ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%ubuntu%' OR lower(label) LIKE '%linux%') THEN 'ubuntu' WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(requested_labels)='array' THEN requested_labels ELSE '[]'::jsonb END) label WHERE lower(label) LIKE '%windows%') THEN 'windows' ELSE 'other' END AS platform, count(*)::int AS count FROM dashboard_jobs WHERE organization_id=${organizationId} AND (status IN ('queued','in_progress') OR queued_at >= now() - ${periodSql(period)}::interval) GROUP BY outcome, platform`;
  return normalizeOverviewJobOutcomes(rows);
}
const periodSql = (period: OverviewDto["period"]) => period === "24h" ? "24 hours" : period === "7d" ? "7 days" : "30 days";
const overviewUtilization = (running: number, concurrency: number) => ({ vcpu: 0, memory: 0, storage: 0, pods: concurrency > 0 ? Math.min(1, running / concurrency) : 0 });
export async function getOverview(db: DashboardDb, organizationId: string, period: OverviewDto["period"]): Promise<OverviewDto> {
  const [row] = await db<OverviewDto[]>`SELECT ${organizationId}::text AS "organizationId", ${period}::text AS period, count(*) FILTER (WHERE j.status='queued' AND NOT EXISTS (SELECT 1 FROM runner_leases l WHERE l.github_job_id=j.github_job_id AND l.state NOT IN ('completed','reaped','failed')))::int AS queued, count(*) FILTER (WHERE j.status='in_progress' OR EXISTS (SELECT 1 FROM runner_leases l WHERE l.github_job_id=j.github_job_id AND l.state NOT IN ('completed','reaped','failed')))::int AS running, count(*) FILTER (WHERE j.status='completed' AND j.conclusion='success')::int AS completed, count(*) FILTER (WHERE j.status='completed' AND j.conclusion <> 'success')::int AS failed, 0::int AS "queueP50Ms", 0::int AS "queueP95Ms", 0::int AS "durationP50Ms", 0::int AS "durationP95Ms", COALESCE((SELECT sum(((CASE WHEN jsonb_typeof(p.resources)='string' THEN (p.resources#>>'{}')::jsonb ELSE p.resources END)->>'concurrency')::int) FROM runner_pools p WHERE p.enabled=true AND (p.organization_id=${organizationId} OR p.organization_id IS NULL)),0)::int AS concurrency, 0::float AS utilization FROM dashboard_jobs j WHERE j.organization_id=${organizationId} AND j.queued_at >= now() - ${periodSql(period)}::interval`;
  return { ...row, utilization: overviewUtilization(row.running, row.concurrency), timeseries: await getOverviewTimeseries(db, period, organizationId), jobOutcomes: await getOverviewJobOutcomes(db, organizationId, period) };
}
export async function getAllOverview(db: DashboardDb, userId: string, period: OverviewDto["period"]): Promise<OverviewDto> {
  const [row] = await db<OverviewDto[]>`SELECT 'all' AS "organizationId", ${period}::text AS period, count(*) FILTER (WHERE j.status='queued' AND NOT EXISTS (SELECT 1 FROM runner_leases l WHERE l.github_job_id=j.github_job_id AND l.state NOT IN ('completed','reaped','failed')))::int AS queued, count(*) FILTER (WHERE j.status='in_progress' OR EXISTS (SELECT 1 FROM runner_leases l WHERE l.github_job_id=j.github_job_id AND l.state NOT IN ('completed','reaped','failed')))::int AS running, count(*) FILTER (WHERE j.status='completed' AND j.conclusion='success')::int AS completed, count(*) FILTER (WHERE j.status='completed' AND j.conclusion <> 'success')::int AS failed, 0::int AS "queueP50Ms", 0::int AS "queueP95Ms", 0::int AS "durationP50Ms", 0::int AS "durationP95Ms", COALESCE((SELECT sum(((CASE WHEN jsonb_typeof(p.resources)='string' THEN (p.resources#>>'{}')::jsonb ELSE p.resources END)->>'concurrency')::int) FROM runner_pools p WHERE p.enabled=true),0)::int AS concurrency, 0::float AS utilization FROM dashboard_jobs j JOIN memberships m ON m.organization_id=j.organization_id AND m.user_id=${userId} WHERE j.queued_at >= now() - ${periodSql(period)}::interval`;
  return { ...row, organizationId: "all", utilization: overviewUtilization(row.running, row.concurrency), timeseries: await getOverviewTimeseries(db, period, "all", userId), jobOutcomes: await getOverviewJobOutcomes(db, "all", period, userId) };
}
export async function listRepositories(db: DashboardDb, organizationId: string, limit = 50, cursor: string | null = null): Promise<CursorPage<RepositorySummary>> { const rows = await db<Record<string, unknown>[]>`SELECT r.id, r.organization_id AS "organizationId", r.name, r.full_name AS "fullName", r.visibility, r.available, r.installation_id AS "installationId", CASE WHEN r.discovery_error='github_403' AND r.discovery_retry_at>now() THEN 'paused' WHEN r.discovery_error='github_403' AND r.discovery_retry_at<=now() THEN 'queued' ELSE 'active' END AS "discoveryState", r.discovery_retry_at AS "discoveryRetryAt" FROM dashboard_repositories r JOIN dashboard_installations i ON i.organization_id=r.organization_id AND i.id=r.installation_id LEFT JOIN dashboard_repositories cursor ON cursor.id=${cursor}::uuid WHERE r.organization_id=${organizationId} AND (cursor.id IS NULL OR (r.full_name,r.id)>(cursor.full_name,cursor.id)) ORDER BY r.full_name,r.id LIMIT ${limit + 1}`; const items = rows.slice(0, limit).map(normalizeRepository); return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null }; }
function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
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
    allocationState: row.allocationState === "whitesmith" || (row.allocationState == null && row.runtimeBoundary != null) ? "whitesmith" : "external",
  } as RunSummary;
}
 export async function listRuns(db: DashboardDb, organizationId: string, limit = 50, cursor: string | null = null, search = ""): Promise<CursorPage<RunSummary>> {
   const rows = await db<Record<string, unknown>[]>`SELECT r.id, r.organization_id AS "organizationId", r.repository_id AS "repositoryId", p.name AS "repositoryName", r.run_number AS "runNumber", r.workflow_name AS "workflowName", r.event, r.branch, r.commit_sha AS "commitSha", r.actor_login AS "actorLogin", r.status, r.conclusion, r.queued_at AS "queuedAt", r.started_at AS "startedAt", r.completed_at AS "completedAt", 0::bigint AS "durationMs", COALESCE(r.runtime_boundary, (SELECT CASE pool.driver WHEN 'tart-vm' THEN 'Tart VM' WHEN 'kata-k3s' THEN 'Kata VM-backed container' WHEN 'windows-hyperv' THEN 'Hyper-V isolated container' END FROM dashboard_jobs j JOIN runner_leases l ON l.github_job_id=j.github_job_id JOIN runner_pools pool ON pool.id=l.pool_id WHERE j.run_id=r.id ORDER BY l.created_at DESC LIMIT 1)) AS "runtimeBoundary", CASE WHEN EXISTS (SELECT 1 FROM dashboard_jobs allocation_job WHERE allocation_job.organization_id=r.organization_id AND allocation_job.run_id=r.id AND ((jsonb_typeof(allocation_job.requested_labels)='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allocation_job.requested_labels) allocation_label WHERE lower(allocation_label) LIKE 'whitesmith-%')) OR (jsonb_typeof(allocation_job.requested_labels)='string' AND lower(allocation_job.requested_labels #>> '{}') LIKE '%"whitesmith-%'))) THEN 'whitesmith' ELSE 'external' END AS "allocationState" FROM dashboard_runs r JOIN dashboard_repositories p ON p.organization_id=r.organization_id AND p.id=r.repository_id LEFT JOIN dashboard_runs cursor_run ON cursor_run.id=${cursor}::uuid WHERE r.organization_id=${organizationId} AND (cursor_run.id IS NULL OR (r.queued_at,r.id)<(cursor_run.queued_at,cursor_run.id)) AND (${search}='' OR lower(concat_ws(' ',p.full_name,r.workflow_name,r.branch,r.actor_login,r.commit_sha)) LIKE lower(${"%" + search + "%"})) ORDER BY r.queued_at DESC, r.id DESC LIMIT ${limit + 1}`;
   const items = rows.slice(0, limit).map(normalizeRunSummary);
   return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
 }
export async function listAllRepositories(db: DashboardDb, userId: string, limit = 50, cursor: string | null = null): Promise<CursorPage<RepositorySummary>> { const rows = await db<Record<string, unknown>[]>`SELECT r.id, r.organization_id AS "organizationId", r.name, r.full_name AS "fullName", r.visibility, r.available, r.installation_id AS "installationId", CASE WHEN r.discovery_error='github_403' AND r.discovery_retry_at>now() THEN 'paused' WHEN r.discovery_error='github_403' AND r.discovery_retry_at<=now() THEN 'queued' ELSE 'active' END AS "discoveryState", r.discovery_retry_at AS "discoveryRetryAt" FROM dashboard_repositories r JOIN memberships m ON m.organization_id=r.organization_id AND m.user_id=${userId} JOIN dashboard_installations i ON i.organization_id=r.organization_id AND i.id=r.installation_id LEFT JOIN dashboard_repositories cursor ON cursor.id=${cursor}::uuid WHERE cursor.id IS NULL OR (r.full_name,r.id)>(cursor.full_name,cursor.id) ORDER BY r.full_name,r.id LIMIT ${limit + 1}`; const items = rows.slice(0, limit).map(normalizeRepository); return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null }; }
export async function listAllRuns(db: DashboardDb, userId: string, limit = 50): Promise<CursorPage<RunSummary>> { const rows = await db<Record<string, unknown>[]>`SELECT r.id, r.organization_id AS "organizationId", r.repository_id AS "repositoryId", p.name AS "repositoryName", r.run_number AS "runNumber", r.workflow_name AS "workflowName", r.event, r.branch, r.commit_sha AS "commitSha", r.actor_login AS "actorLogin", r.status, r.conclusion, r.queued_at AS "queuedAt", r.started_at AS "startedAt", r.completed_at AS "completedAt", 0::bigint AS "durationMs", COALESCE(r.runtime_boundary, (SELECT CASE pool.driver WHEN 'tart-vm' THEN 'Tart VM' WHEN 'kata-k3s' THEN 'Kata VM-backed container' WHEN 'windows-hyperv' THEN 'Hyper-V isolated container' END FROM dashboard_jobs j JOIN runner_leases l ON l.github_job_id=j.github_job_id JOIN runner_pools pool ON pool.id=l.pool_id WHERE j.run_id=r.id ORDER BY l.created_at DESC LIMIT 1)) AS "runtimeBoundary", CASE WHEN EXISTS (SELECT 1 FROM dashboard_jobs allocation_job WHERE allocation_job.organization_id=r.organization_id AND allocation_job.run_id=r.id AND ((jsonb_typeof(allocation_job.requested_labels)='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allocation_job.requested_labels) allocation_label WHERE lower(allocation_label) LIKE 'whitesmith-%')) OR (jsonb_typeof(allocation_job.requested_labels)='string' AND lower(allocation_job.requested_labels #>> '{}') LIKE '%"whitesmith-%'))) THEN 'whitesmith' ELSE 'external' END AS "allocationState" FROM dashboard_runs r JOIN memberships m ON m.organization_id=r.organization_id AND m.user_id=${userId} JOIN dashboard_repositories p ON p.organization_id=r.organization_id AND p.id=r.repository_id ORDER BY r.queued_at DESC LIMIT ${limit + 1}`; const items = rows.slice(0, limit).map(normalizeRunSummary); return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }; }
export async function listAllPools(db: DashboardDb, userId: string, limit = 50): Promise<CursorPage<PoolSummary>> { const rows = await db<Record<string, unknown>[]>`SELECT p.id,p.organization_id AS "organizationId",p.worker_id AS "workerId",w.name AS "workerName",p.name,p.platform,p.driver,p.image_digest AS "imageDigest",p.resources,p.labels,p.trigger_label AS "triggerLabel",p.enabled,0::int AS active FROM runner_pools p JOIN memberships m ON m.organization_id=p.organization_id AND m.user_id=${userId} JOIN workers w ON w.id=p.worker_id ORDER BY p.name LIMIT ${limit + 1}`; const items = rows.slice(0, limit).map(normalizePool); return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null }; }
export async function getRunDetail(db: DashboardDb, organizationId: string, runId: string): Promise<RunDetail | null> {
  const run = (await listRuns(db, organizationId, 1000)).items.find((item) => item.id === runId);
  if (!run) return null;
  const jobRows = await db<Record<string, unknown>[]>`
    SELECT id,name,status,conclusion,stage,runner_name AS "runnerName",logs_state AS "logsState",
      requested,requested_labels AS "requestedLabels",observed
    FROM dashboard_jobs WHERE organization_id=${organizationId} AND run_id=${runId} ORDER BY id
  `;
  const stepRows = await db<Record<string, unknown>[]>`
    SELECT id,job_id AS "jobId",name,number,status,conclusion,queued_at AS "queuedAt",
      started_at AS "startedAt",completed_at AS "completedAt",duration_ms AS "durationMs"
    FROM dashboard_job_steps
    WHERE organization_id=${organizationId} AND run_id=${runId}
    ORDER BY job_id,number,id
  `;
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
      steps: stepsByJob.get(String(row.id)) ?? [],
    };
  });
  const edges: ActionGraph["edges"] = [];
  const stageRows = await db<Record<string, unknown>[]>`
    SELECT stage,started_at AS "startedAt",completed_at AS "completedAt",
      COALESCE(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000,0)::bigint AS "durationMs"
    FROM dashboard_run_stages WHERE organization_id=${organizationId} AND run_id=${runId} ORDER BY started_at
  `;
  const stages = stageRows.map((row): RunStageRecord => ({
    stage: row.stage as RunStageRecord["stage"],
    startedAt: normalizeTimestamp(row.startedAt)!,
    completedAt: normalizeTimestamp(row.completedAt),
    durationMs: Math.max(0, Number(row.durationMs) || 0),
  }));
  return { ...run, jobs, stages, actionGraph: { nodes: jobs.map((job) => ({ id: job.id, name: job.name, status: job.stage })), edges } as ActionGraph };
}
export async function listStepLogChunks(db: DashboardDb, organizationId: string, runId: string, jobId: string, stepId: string, after = -1, limit = 100): Promise<CursorPage<LogChunk>> {
  const safeLimit = Math.max(0, Math.min(1000, Math.floor(limit)));
  if (safeLimit === 0) return { items: [], nextCursor: null };
  const rows = await db<LogChunk[]>`SELECT organization_id AS "organizationId", run_id AS "runId", job_id AS "jobId", sequence, content, false AS "hasMore", occurred_at AS "occurredAt" FROM dashboard_step_log_chunks WHERE organization_id=${organizationId} AND run_id=${runId} AND job_id=${jobId} AND step_id=${stepId} AND sequence>${after} ORDER BY sequence LIMIT ${safeLimit + 1}`;
  return { items: rows.slice(0, safeLimit).map(x => ({ ...x, sequence: Number(x.sequence), hasMore: rows.length > safeLimit })), nextCursor: rows.length > safeLimit ? String(rows[safeLimit - 1].sequence) : null };
}
export async function listLogChunks(db: DashboardDb, organizationId: string, runId: string, jobId: string, after = -1, limit = 100): Promise<CursorPage<LogChunk>> { const rows = await db<LogChunk[]>`SELECT organization_id AS "organizationId", run_id AS "runId", job_id AS "jobId", sequence, content, false AS "hasMore", occurred_at AS "occurredAt" FROM dashboard_log_chunks WHERE organization_id=${organizationId} AND run_id=${runId} AND job_id=${jobId} AND sequence>${after} ORDER BY sequence LIMIT ${limit + 1}`; return { items: rows.slice(0, limit).map(x => ({ ...x, sequence: Number(x.sequence), hasMore: rows.length > limit })), nextCursor: rows.length > limit ? String(rows[limit - 1].sequence) : null }; }
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
  const source = wrapper.doctor && typeof wrapper.doctor === "object" ? wrapper.doctor as Record<string, unknown> : null;
  if (!source) return null;
  const candidate: Record<string, unknown> = {};
  for (const key of ["nestedKvm", "kvmModules", "probe", "egress", "imageSignatures", "blockVolume"]) {
    if (typeof source[key] === "boolean") candidate[key] = source[key];
  }
  if (typeof source.runtimeHandler === "string") candidate.runtimeHandler = source.runtimeHandler;
  if (typeof source.remediation === "string" || source.remediation === null) candidate.remediation = source.remediation;
  if (source.versions && typeof source.versions === "object") candidate.versions = source.versions;
  const result = WorkerDoctor.safeParse(candidate);
  return result.success ? result.data : null;
}
function normalizeWorker(row: Record<string, unknown>): WorkerDetail {
  const platform = RuntimePlatform.parse(row.platform);
  const driver = RuntimeDriverName.parse(platform === "linux-x64" ? "kata-k3s" : platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm");
  const rawGuestPlatforms = jsonValue(row.guestPlatforms);
  const guestPlatforms = Array.isArray(rawGuestPlatforms) && rawGuestPlatforms.length > 0 ? rawGuestPlatforms.map((value) => GuestPlatform.parse(value)) : [platform];
  const limitsValue = WorkerLimits.safeParse(jsonValue(row.limits));
  return { ...row, platform, guestPlatforms, driver, limits: limitsValue.success ? limitsValue.data : null, doctor: workerDoctor(row.doctor), capacity: workerCapacity(row.doctor), activeSandboxes: numberValue(row.activeSandboxes, 0), draining: row.draining === true } as WorkerDetail;
}
export async function listWorkers(db: DashboardDb, organizationId: string, limit = 50): Promise<CursorPage<WorkerDetail>> { const rows = await db<Record<string, unknown>[]>`SELECT id, NULL::uuid AS "organizationId", name, platform, guest_platforms AS "guestPlatforms", admission_state AS "admissionState", connection_state AS "connectionState", configuration_state AS "configurationState", fingerprint, limits, doctor, 0 AS "activeSandboxes", false AS draining FROM workers ORDER BY name LIMIT ${limit + 1}`; const items = rows.slice(0, limit).map(normalizeWorker); return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null }; }
export async function listAllWorkers(db: DashboardDb, userId: string, limit = 50, includeInactive = false): Promise<CursorPage<WorkerDetail>> {
  const rows = await db<Record<string, unknown>[]>`SELECT w.id, NULL::uuid AS "organizationId", w.name, w.platform, w.guest_platforms AS "guestPlatforms", w.admission_state AS "admissionState", w.connection_state AS "connectionState", w.configuration_state AS "configurationState", w.fingerprint, w.limits, w.doctor, 0 AS "activeSandboxes", false AS draining FROM workers w WHERE ${includeInactive} OR w.admission_state NOT IN ('rejected','revoked') ORDER BY w.name LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map(normalizeWorker);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
export async function getWorkerDetail(db: DashboardDb, organizationId: string, workerId: string): Promise<WorkerDetail | null> { const page = await listWorkers(db, organizationId, 1000); return page.items.find(worker => worker.id === workerId) ?? null; }
export async function recordRunTransition(db: DashboardDb, organizationId: string, runId: string, transition: RunTransition): Promise<void> { await db`UPDATE dashboard_runs SET status=${transition.status}, conclusion=${transition.conclusion}, started_at=COALESCE(${transition.startedAt ?? null}, started_at), completed_at=COALESCE(${transition.completedAt ?? null}, completed_at) WHERE organization_id=${organizationId} AND id=${runId} AND status <> 'completed' AND (status='queued' OR ${transition.status} <> 'queued')`; }
export async function recordRunStage(db: DashboardDb, organizationId: string, runId: string, stage: RunStage): Promise<void> { await db`INSERT INTO dashboard_run_stages (organization_id,run_id,stage) VALUES (${organizationId},${runId},${stage}) ON CONFLICT DO NOTHING`; }
function normalizePool(row: Record<string, unknown>): PoolSummary { return PoolSummary.parse({ ...row, resources: jsonValue(row.resources), labels: jsonValue(row.labels), active: numberValue(row.active, 0) }); }
export async function listPools(db: DashboardDb, organizationId: string, limit = 50): Promise<CursorPage<PoolSummary>> {
  const rows = await db<Record<string, unknown>[]>`SELECT p.id,p.organization_id AS "organizationId",p.worker_id AS "workerId",w.name AS "workerName",p.name,p.platform,p.driver,p.image_digest AS "imageDigest",p.resources,p.labels,p.trigger_label AS "triggerLabel",p.enabled,0::int AS active FROM runner_pools p JOIN workers w ON w.id=p.worker_id WHERE p.organization_id=${organizationId} ORDER BY p.name LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map(normalizePool);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
export async function listGlobalPools(db: DashboardDb, limit = 50): Promise<CursorPage<PoolSummary>> {
  const rows = await db<Record<string, unknown>[]>`SELECT p.id,NULL::uuid AS "organizationId",NULL::uuid AS "workerId",'Shared fleet' AS "workerName",p.name,p.platform,p.driver,p.image_digest AS "imageDigest",p.resources,p.labels,p.trigger_label AS "triggerLabel",p.enabled,(SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.state NOT IN ('completed','reaped','failed')) AS active FROM runner_pools p WHERE p.organization_id IS NULL ORDER BY p.name LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map(normalizePool);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
function normalizeOrganizationSettings(row: Record<string, unknown>): OrganizationSettings {
  return {
    organizationId: String(row.organizationId),
    maxVcpuPerPod: Number(row.maxVcpuPerPod),
    maxMemoryBytesPerPod: Number(row.maxMemoryBytesPerPod),
    maxStorageBytesPerPod: Number(row.maxStorageBytesPerPod),
    maxConcurrentPods: Number(row.maxConcurrentPods),
  };
}
export async function getOrganizationSettings(db: DashboardDb, organizationId: string): Promise<OrganizationSettings> {
  const [row] = await db<Record<string, unknown>[]>`INSERT INTO organization_settings (organization_id) VALUES (${organizationId}) ON CONFLICT (organization_id) DO NOTHING RETURNING organization_id AS "organizationId",max_vcpu_per_pod AS "maxVcpuPerPod",max_memory_bytes_per_pod AS "maxMemoryBytesPerPod",max_storage_bytes_per_pod AS "maxStorageBytesPerPod",max_concurrent_pods AS "maxConcurrentPods"`;
  if (row) return normalizeOrganizationSettings(row);
  const [existing] = await db<Record<string, unknown>[]>`SELECT organization_id AS "organizationId",max_vcpu_per_pod AS "maxVcpuPerPod",max_memory_bytes_per_pod AS "maxMemoryBytesPerPod",max_storage_bytes_per_pod AS "maxStorageBytesPerPod",max_concurrent_pods AS "maxConcurrentPods" FROM organization_settings WHERE organization_id=${organizationId}`;
  return normalizeOrganizationSettings(existing);
}
export async function updateOrganizationSettings(db: DashboardDb, value: OrganizationSettings): Promise<OrganizationSettings> {
  const [row] = await db<Record<string, unknown>[]>`INSERT INTO organization_settings (organization_id,max_vcpu_per_pod,max_memory_bytes_per_pod,max_storage_bytes_per_pod,max_concurrent_pods) VALUES (${value.organizationId},${value.maxVcpuPerPod},${value.maxMemoryBytesPerPod},${value.maxStorageBytesPerPod},${value.maxConcurrentPods}) ON CONFLICT (organization_id) DO UPDATE SET max_vcpu_per_pod=excluded.max_vcpu_per_pod,max_memory_bytes_per_pod=excluded.max_memory_bytes_per_pod,max_storage_bytes_per_pod=excluded.max_storage_bytes_per_pod,max_concurrent_pods=excluded.max_concurrent_pods,updated_at=now() RETURNING organization_id AS "organizationId",max_vcpu_per_pod AS "maxVcpuPerPod",max_memory_bytes_per_pod AS "maxMemoryBytesPerPod",max_storage_bytes_per_pod AS "maxStorageBytesPerPod",max_concurrent_pods AS "maxConcurrentPods"`;
  return normalizeOrganizationSettings(row);
}
export async function dashboardMutation(db: DashboardDb, organizationId: string, key: string): Promise<boolean> { const rows = await db`INSERT INTO dashboard_mutations (organization_id,idempotency_key) VALUES (${organizationId},${key}) ON CONFLICT DO NOTHING RETURNING idempotency_key`; return rows.length > 0; }
export async function invalidateDashboard(db: DashboardDb, organizationId: string, keys: string[]): Promise<void> { await db`INSERT INTO dashboard_outbox_invalidations (organization_id,sequence,keys) SELECT ${organizationId},COALESCE(MAX(sequence),0)+1,${JSON.stringify(keys)}::jsonb FROM dashboard_outbox_invalidations WHERE organization_id=${organizationId}`; }

export type QueueRepositoryDiscoveryRecheckResult = "queued" | "not_found" | "not_paused";

export async function queueRepositoryDiscoveryRecheck(
  db: DashboardDb,
  organizationId: string,
  repositoryId: string,
  idempotencyKey: string,
): Promise<QueueRepositoryDiscoveryRecheckResult> {
  const mutationKey = `repository-discovery-recheck:${repositoryId}:${idempotencyKey}`;
  return db.begin(async (tx) => {
    const [repository] = await tx`
      SELECT r.discovery_error='github_403' AND r.discovery_retry_at>now() AS paused
      FROM dashboard_repositories r
      JOIN dashboard_installations i
        ON i.id=r.installation_id AND i.organization_id=r.organization_id
      WHERE r.organization_id=${organizationId} AND r.id=${repositoryId}
        AND r.available=true AND i.state='approved'
      FOR UPDATE OF r
    `;
    const [prior] = await tx`
      SELECT 1 FROM dashboard_mutations
      WHERE organization_id=${organizationId} AND idempotency_key=${mutationKey}
    `;
    if (prior) return "queued";
    if (!repository) return "not_found";
    if (repository.paused !== true) return "not_paused";

    const inserted = await tx`
      INSERT INTO dashboard_mutations (organization_id,idempotency_key)
      VALUES (${organizationId},${mutationKey})
      ON CONFLICT DO NOTHING RETURNING idempotency_key
    `;
    if (!inserted.length) return "queued";

    await tx`
      UPDATE dashboard_repositories SET discovery_retry_at=now()
      WHERE organization_id=${organizationId} AND id=${repositoryId}
    `;
    return "queued";
  });
}
