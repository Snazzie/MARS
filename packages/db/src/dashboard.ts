import type { Sql } from "postgres";
import { CapacitySnapshot, PoolSummary, RuntimeDriverName, RuntimePlatform, WorkerDoctor, WorkerLimits } from "@whitesmith/contracts";
import type { ActionGraph, CursorPage, LogChunk, OrganizationSummary, OverviewDto, RepositorySummary, RunDetail, RunJob, RunStage, RunStageRecord, RunSummary, WorkerDetail, OrganizationSettings } from "@whitesmith/contracts";
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
  return await db<OrganizationSummary[]>`SELECT o.id, o.login AS name, o.login, m.role, (SELECT count(*)::int FROM dashboard_repositories r WHERE r.organization_id=o.id) AS "repositoryCount", (SELECT count(*)::int FROM workers w WHERE w.organization_id=o.id) AS "workerCount" FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=${userId} ORDER BY o.login`;
}
export async function getOverview(db: DashboardDb, organizationId: string, period: OverviewDto["period"]): Promise<OverviewDto> {
  const [row] = await db<OverviewDto[]>`SELECT ${organizationId}::text AS "organizationId", ${period}::text AS period, count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='in_progress')::int AS running, count(*) FILTER (WHERE status='completed' AND conclusion='success')::int AS completed, count(*) FILTER (WHERE status='completed' AND conclusion <> 'success')::int AS failed, 0::int AS "queueP50Ms", 0::int AS "queueP95Ms", 0::int AS "durationP50Ms", 0::int AS "durationP95Ms", 0::int AS concurrency, 0::float AS utilization FROM dashboard_runs WHERE organization_id=${organizationId} AND queued_at >= now() - CASE ${period} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END`;
  return { ...row, utilization: { vcpu: 0, memory: 0, storage: 0, pods: 0 } };
}
export async function getAllOverview(db: DashboardDb, userId: string, period: OverviewDto["period"]): Promise<OverviewDto> {
  const [row] = await db<OverviewDto[]>`SELECT ${period} AS period, count(*) FILTER (WHERE r.status='queued')::int AS queued, count(*) FILTER (WHERE r.status='in_progress')::int AS running, count(*) FILTER (WHERE r.status='completed' AND r.conclusion='success')::int AS completed, count(*) FILTER (WHERE r.status='completed' AND r.conclusion <> 'success')::int AS failed, 0::int AS "queueP50Ms", 0::int AS "queueP95Ms", 0::int AS "durationP50Ms", 0::int AS "durationP95Ms", 0::int AS concurrency, 0::float AS utilization FROM dashboard_runs r JOIN memberships m ON m.organization_id=r.organization_id AND m.user_id=${userId} WHERE r.queued_at >= now() - CASE ${period} WHEN '24h' THEN interval '24 hours' WHEN '7d' THEN interval '7 days' ELSE interval '30 days' END`;
  return { ...row, organizationId: "all", utilization: { vcpu: 0, memory: 0, storage: 0, pods: 0 } };
}
export async function listRepositories(db: DashboardDb, organizationId: string, limit = 50): Promise<CursorPage<RepositorySummary>> { const rows = await db<RepositorySummary[]>`SELECT r.id, r.organization_id AS "organizationId", r.name, r.full_name AS "fullName", r.visibility, r.available, r.approved, r.installation_id AS "installationId" FROM dashboard_repositories r JOIN dashboard_installations i ON i.organization_id=r.organization_id AND i.id=r.installation_id WHERE r.organization_id=${organizationId} ORDER BY r.full_name LIMIT ${limit + 1}`; return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null }; }
export async function listRuns(db: DashboardDb, organizationId: string, limit = 50): Promise<CursorPage<RunSummary>> { const rows = await db<RunSummary[]>`SELECT r.id, r.organization_id AS "organizationId", r.repository_id AS "repositoryId", p.name AS "repositoryName", r.run_number AS "runNumber", r.workflow_name AS "workflowName", r.event, r.branch, r.commit_sha AS "commitSha", r.actor_login AS "actorLogin", r.status, r.conclusion, r.queued_at AS "queuedAt", r.started_at AS "startedAt", r.completed_at AS "completedAt", 0::bigint AS "durationMs", r.runtime_boundary AS "runtimeBoundary" FROM dashboard_runs r JOIN dashboard_repositories p ON p.organization_id=r.organization_id AND p.id=r.repository_id WHERE r.organization_id=${organizationId} ORDER BY r.queued_at DESC, r.id DESC LIMIT ${limit + 1}`; return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null }; }
export async function listAllRepositories(db: DashboardDb, userId: string, limit = 50): Promise<CursorPage<RepositorySummary>> { const rows = await db<RepositorySummary[]>`SELECT r.id, r.organization_id AS "organizationId", r.name, r.full_name AS "fullName", r.visibility, r.available, r.approved, r.installation_id AS "installationId" FROM dashboard_repositories r JOIN memberships m ON m.organization_id=r.organization_id AND m.user_id=${userId} JOIN dashboard_installations i ON i.organization_id=r.organization_id AND i.id=r.installation_id ORDER BY r.full_name LIMIT ${limit + 1}`; return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null }; }
export async function listAllRuns(db: DashboardDb, userId: string, limit = 50): Promise<CursorPage<RunSummary>> { const rows = await db<RunSummary[]>`SELECT r.id, r.organization_id AS "organizationId", r.repository_id AS "repositoryId", p.name AS "repositoryName", r.run_number AS "runNumber", r.workflow_name AS "workflowName", r.event, r.branch, r.commit_sha AS "commitSha", r.actor_login AS "actorLogin", r.status, r.conclusion, r.queued_at AS "queuedAt", r.started_at AS "startedAt", r.completed_at AS "completedAt", 0::bigint AS "durationMs", r.runtime_boundary AS "runtimeBoundary" FROM dashboard_runs r JOIN memberships m ON m.organization_id=r.organization_id AND m.user_id=${userId} JOIN dashboard_repositories p ON p.organization_id=r.organization_id AND p.id=r.repository_id ORDER BY r.queued_at DESC, r.id DESC LIMIT ${limit + 1}`; return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null }; }
export async function listAllPools(db: DashboardDb, userId: string, limit = 50): Promise<CursorPage<PoolSummary>> { const rows = await db<Record<string, unknown>[]>`SELECT p.id,p.organization_id AS "organizationId",p.worker_id AS "workerId",w.name AS "workerName",p.name,p.platform,p.driver,p.image_digest AS "imageDigest",p.resources,p.labels,p.trigger_label AS "triggerLabel",p.enabled,0::int AS active FROM runner_pools p JOIN memberships m ON m.organization_id=p.organization_id AND m.user_id=${userId} JOIN workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id ORDER BY p.name LIMIT ${limit + 1}`; const items = rows.slice(0, limit).map(normalizePool); return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null }; }
export async function getRunDetail(db: DashboardDb, organizationId: string, runId: string): Promise<RunDetail | null> { const [run] = await listRuns(db, organizationId, 1000).then(page => page.items.filter(x => x.id === runId)); if (!run) return null; const jobs = await db<RunJob[]>`SELECT id,name,status,conclusion,stage,runner_name AS "runnerName",requested,observed FROM dashboard_jobs WHERE organization_id=${organizationId} AND run_id=${runId} ORDER BY id`; const edges = await db<{from:string;to:string}[]>`SELECT from_job_id AS from,to_job_id AS to FROM dashboard_action_edges WHERE organization_id=${organizationId} AND run_id=${runId}`; const stages = await db<RunStageRecord[]>`SELECT stage, started_at AS "startedAt", completed_at AS "completedAt", COALESCE(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000, 0)::bigint AS "durationMs" FROM dashboard_run_stages WHERE organization_id=${organizationId} AND run_id=${runId} ORDER BY started_at`; return { ...run, jobs, stages, actionGraph: { nodes: jobs.map(job => ({ id: job.id, name: job.name, status: job.stage })), edges } as ActionGraph }; }
export async function listLogChunks(db: DashboardDb, organizationId: string, runId: string, jobId: string, after = -1, limit = 100): Promise<CursorPage<LogChunk>> { const rows = await db<LogChunk[]>`SELECT organization_id AS "organizationId", run_id AS "runId", job_id AS "jobId", sequence, content, false AS "hasMore", occurred_at AS "occurredAt" FROM dashboard_log_chunks WHERE organization_id=${organizationId} AND run_id=${runId} AND job_id=${jobId} AND sequence>${after} ORDER BY sequence LIMIT ${limit + 1}`; return { items: rows.slice(0, limit).map(x => ({ ...x, hasMore: rows.length > limit })), nextCursor: rows.length > limit ? String(rows[limit - 1].sequence) : null }; }
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
  const driver = RuntimeDriverName.parse(platform === "linux-x64" ? "kata-k3s" : platform === "windows-x64" ? "windows-hyperv" : "tart-vm");
  const limitsValue = WorkerLimits.safeParse(jsonValue(row.limits));
  return {
    ...row,
    platform,
    driver,
    limits: limitsValue.success ? limitsValue.data : null,
    doctor: workerDoctor(row.doctor),
    capacity: workerCapacity(row.doctor),
    activeSandboxes: numberValue(row.activeSandboxes, 0),
    draining: row.draining === true,
  } as WorkerDetail;
}
export async function listWorkers(db: DashboardDb, organizationId: string, limit = 50): Promise<CursorPage<WorkerDetail>> { const rows = await db<Record<string, unknown>[]>`SELECT id, organization_id AS "organizationId", name, platform, admission_state AS "admissionState", connection_state AS "connectionState", configuration_state AS "configurationState", fingerprint, limits, doctor, 0 AS "activeSandboxes", false AS draining FROM workers WHERE organization_id=${organizationId} ORDER BY name LIMIT ${limit + 1}`; const items = rows.slice(0, limit).map(normalizeWorker); return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null }; }
export async function listAllWorkers(db: DashboardDb, userId: string, limit = 50): Promise<CursorPage<WorkerDetail>> {
  const rows = await db<Record<string, unknown>[]>`SELECT w.id, w.organization_id AS "organizationId", w.name, w.platform, w.admission_state AS "admissionState", w.connection_state AS "connectionState", w.configuration_state AS "configurationState", w.fingerprint, w.limits, w.doctor, 0 AS "activeSandboxes", false AS draining FROM workers w JOIN memberships m ON m.organization_id=w.organization_id AND m.user_id=${userId} ORDER BY w.name LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map(normalizeWorker);
  return { items, nextCursor: rows.length > limit ? String(items.at(-1)?.id) : null };
}
export async function getWorkerDetail(db: DashboardDb, organizationId: string, workerId: string): Promise<WorkerDetail | null> { const page = await listWorkers(db, organizationId, 1000); return page.items.find(worker => worker.id === workerId) ?? null; }
export async function recordRunTransition(db: DashboardDb, organizationId: string, runId: string, transition: RunTransition): Promise<void> { await db`UPDATE dashboard_runs SET status=${transition.status}, conclusion=${transition.conclusion}, started_at=COALESCE(${transition.startedAt ?? null}, started_at), completed_at=COALESCE(${transition.completedAt ?? null}, completed_at) WHERE organization_id=${organizationId} AND id=${runId} AND status <> 'completed' AND (status='queued' OR ${transition.status} <> 'queued')`; }
export async function recordRunStage(db: DashboardDb, organizationId: string, runId: string, stage: RunStage): Promise<void> { await db`INSERT INTO dashboard_run_stages (organization_id,run_id,stage) VALUES (${organizationId},${runId},${stage}) ON CONFLICT DO NOTHING`; }
function normalizePool(row: Record<string, unknown>): PoolSummary { return PoolSummary.parse({ ...row, resources: jsonValue(row.resources), labels: jsonValue(row.labels), active: numberValue(row.active, 0) }); }
export async function listPools(db: DashboardDb, organizationId: string, limit = 50): Promise<CursorPage<PoolSummary>> {
  const rows = await db<Record<string, unknown>[]>`SELECT p.id,p.organization_id AS "organizationId",p.worker_id AS "workerId",w.name AS "workerName",p.name,p.platform,p.driver,p.image_digest AS "imageDigest",p.resources,p.labels,p.trigger_label AS "triggerLabel",p.enabled,0::int AS active FROM runner_pools p JOIN workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id WHERE p.organization_id=${organizationId} ORDER BY p.name LIMIT ${limit + 1}`;
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
