import type { JobResourceTrendJob, JobResourceTrendPoint, JobResourceTrendResponse, JobResourceTrendSort } from "@mars/contracts";
import type { DatabaseClient } from "./index.ts";
import { resourceTrendQueries } from "./job-resource-trend-queries.ts";

export type JobResourceTrendQuery = {
  from: string; to: string; platform?: string; vcpu?: number; concurrency?: number;
  workerId?: string; search?: string; sort?: JobResourceTrendSort; cursor?: string | null;
  limit?: number; jobKey?: string; pointLimit?: number;
};
export type JobResourceIdentity = { repositoryId: string; workflowName: string; jobName: string };
export type JobResourceCursor = { sortValue: string | number; jobKey: string };

export class JobResourceTrendInputError extends Error {
  readonly code = "invalid_resource_trend_query";
  constructor(message = "Invalid job resource trend query") { super(message); this.name = "JobResourceTrendInputError"; }
}

const identityKeys = ["repositoryId", "workflowName", "jobName"] as const;
const cursorKeys = ["sortValue", "jobKey"] as const;
const sorts = new Set<JobResourceTrendSort>(["latest", "duration", "cpu", "memory", "runs"]);
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}
function parseIdentity(value: unknown): JobResourceIdentity | null {
  if (!exactObject(value, identityKeys)) return null;
  if (typeof value.repositoryId !== "string" || !value.repositoryId || typeof value.workflowName !== "string" || !value.workflowName || typeof value.jobName !== "string" || !value.jobName) return null;
  return { repositoryId: value.repositoryId, workflowName: value.workflowName, jobName: value.jobName };
}
function parseCursor(value: unknown): JobResourceCursor | null {
  if (!exactObject(value, cursorKeys)) return null;
  const sortValue = value.sortValue;
  if (!((typeof sortValue === "string" && sortValue.length > 0) || (typeof sortValue === "number" && Number.isFinite(sortValue)))) return null;
  if (typeof value.jobKey !== "string" || !value.jobKey) return null;
  return { sortValue, jobKey: value.jobKey };
}
function decodeJson(value: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error("invalid encoding");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
export function encodeJobResourceKey(identity: JobResourceIdentity): string {
  const parsed = parseIdentity(identity);
  if (!parsed) throw new JobResourceTrendInputError("Invalid job resource key");
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}
export function decodeJobResourceKey(value: string): JobResourceIdentity | null {
  try { return parseIdentity(decodeJson(value)); } catch { return null; }
}
export function encodeJobResourceCursor(cursor: JobResourceCursor): string {
  const parsed = parseCursor(cursor);
  if (!parsed) throw new JobResourceTrendInputError("Invalid job resource cursor");
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}
export function decodeJobResourceCursor(value: string): JobResourceCursor | null {
  try { return parseCursor(decodeJson(value)); } catch { return null; }
}

type ValidatedQuery = {
  from: string; to: string; platform: string | null; vcpu: number | null; concurrency: number | null; workerId: string | null;
  searchPattern: string; sort: JobResourceTrendSort;
  cursor: (JobResourceCursor & { identity: JobResourceIdentity }) | null;
  limit: number; requestedIdentity: JobResourceIdentity | null; pointLimit: number;
};
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
const uuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function normalizeLimit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new JobResourceTrendInputError();
  return value;
}
function searchPattern(value: string): string { return value ? `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%` : ""; }
function validateQuery(query: JobResourceTrendQuery): ValidatedQuery {
  const fromMs = Date.parse(query.from), toMs = Date.parse(query.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new JobResourceTrendInputError();
  if (query.vcpu !== undefined && !positiveInteger(query.vcpu)) throw new JobResourceTrendInputError();
  if (query.concurrency !== undefined && !positiveInteger(query.concurrency)) throw new JobResourceTrendInputError();
  if (query.platform !== undefined && typeof query.platform !== "string") throw new JobResourceTrendInputError();
  if (query.workerId !== undefined && (typeof query.workerId !== "string" || !uuid(query.workerId))) throw new JobResourceTrendInputError();
  if (query.search !== undefined && typeof query.search !== "string") throw new JobResourceTrendInputError();
  const sort = query.sort ?? "latest";
  if (!sorts.has(sort)) throw new JobResourceTrendInputError();
  let requestedIdentity: JobResourceIdentity | null = null;
  if (query.jobKey !== undefined) {
    requestedIdentity = decodeJobResourceKey(query.jobKey);
    if (!requestedIdentity || !uuid(requestedIdentity.repositoryId)) throw new JobResourceTrendInputError("Invalid job resource key");
  }
  let cursor: ValidatedQuery["cursor"] = null;
  if (query.cursor !== undefined && query.cursor !== null) {
    const decoded = decodeJobResourceCursor(query.cursor), identity = decoded && decodeJobResourceKey(decoded.jobKey);
    if (!decoded || !identity || !uuid(identity.repositoryId)) throw new JobResourceTrendInputError("Invalid job resource cursor");
    if (sort === "latest") {
      if (typeof decoded.sortValue !== "string" || !Number.isFinite(Date.parse(decoded.sortValue))) throw new JobResourceTrendInputError("Invalid job resource cursor");
    } else if (typeof decoded.sortValue !== "number" || !Number.isFinite(decoded.sortValue)) throw new JobResourceTrendInputError("Invalid job resource cursor");
    cursor = { ...decoded, identity };
  }
  return {
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), platform: query.platform ?? null,
    vcpu: query.vcpu ?? null, concurrency: query.concurrency ?? null, workerId: query.workerId ?? null,
    searchPattern: searchPattern(query.search ?? ""), sort, cursor,
    limit: normalizeLimit(query.limit, 50, 1, 100), requestedIdentity, pointLimit: normalizeLimit(query.pointLimit, 100, 2, 200),
  };
}
function filterParameters(organizationId: string, query: ValidatedQuery, userId?: string) {
  return { organizationId, from: query.from, to: query.to, platform: query.platform, vcpu: query.vcpu,
    concurrency: query.concurrency, search: query.searchPattern, userId: userId ?? null, workerId: query.workerId };
}
type FilterParameters = ReturnType<typeof filterParameters>;
const asNumber = (value: unknown): number => Number(value ?? 0);
const asNullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const asIso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  const milliseconds = Date.parse(String(value));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : String(value);
};
function identityFromRow(row: Record<string, unknown>): JobResourceIdentity {
  return { repositoryId: String(row.repositoryId), workflowName: String(row.workflowName), jobName: String(row.jobName) };
}
function normalizeJob(row: Record<string, unknown>): JobResourceTrendJob {
  const runCount = asNumber(row.runCount), telemetryCoveredRunCount = asNumber(row.telemetryCoveredRunCount);
  return {
    jobKey: encodeJobResourceKey(identityFromRow(row)), repositoryId: String(row.repositoryId), repositoryName: String(row.repositoryName),
    workflowName: String(row.workflowName), jobName: String(row.jobName), platform: String(row.platform), runCount,
    latestCompletedAt: asIso(row.latestCompletedAt),
    latestRequestedVcpu: asNumber(row.latestRequestedVcpu),
    latestRequestedMemoryBytes: asNumber(row.latestRequestedMemoryBytes),
    latestEffectiveConcurrency: asNumber(row.latestEffectiveConcurrency),
    medianExecutionDurationMs: asNumber(row.medianExecutionDurationMs),
    cpuPeakPercent: asNullableNumber(row.cpuPeakPercent), memoryPeakBytes: asNullableNumber(row.memoryPeakBytes), telemetryCoveredRunCount,
    telemetryCoveragePercent: runCount === 0 ? 0 : telemetryCoveredRunCount / runCount * 100,
    durationChangePercent: asNullableNumber(row.durationChangePercent), cpuChangePercent: asNullableNumber(row.cpuChangePercent), memoryChangePercent: asNullableNumber(row.memoryChangePercent),
  };
}
function normalizePoint(row: Record<string, unknown>): JobResourceTrendPoint {
  return {
    organizationId: String(row.organizationId), runId: String(row.runId), jobId: String(row.jobId), completedAt: asIso(row.completedAt),
    outcome: row.outcome as JobResourceTrendPoint["outcome"], executionDurationMs: asNumber(row.executionDurationMs),
    cpuAveragePercent: asNullableNumber(row.cpuAveragePercent), cpuPeakPercent: asNullableNumber(row.cpuPeakPercent), memoryPeakBytes: asNullableNumber(row.memoryPeakBytes),
    requestedVcpu: asNumber(row.requestedVcpu), requestedMemoryBytes: asNumber(row.requestedMemoryBytes), effectiveConcurrency: asNumber(row.effectiveConcurrency),
    telemetryState: row.telemetryState === "available" || row.telemetryState === "partial" ? row.telemetryState : "unavailable", telemetrySampleCount: asNumber(row.telemetrySampleCount),
  };
}
function cursorSortValue(job: JobResourceTrendJob, sort: JobResourceTrendSort): string | number {
  if (sort === "latest") return job.latestCompletedAt;
  if (sort === "duration") return job.medianExecutionDurationMs;
  if (sort === "cpu") return job.cpuPeakPercent ?? -1;
  if (sort === "memory") return job.memoryPeakBytes ?? -1;
  return job.runCount;
}
async function loadPoints(db: DatabaseClient, filterParams: FilterParameters, identity: JobResourceIdentity, pointLimit: number): Promise<JobResourceTrendPoint[]> {
  const rows = await resourceTrendQueries(db).points.execute({ ...filterParams, ...identity, pointLimit });
  return rows.map(normalizePoint).sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.jobId.localeCompare(right.jobId)).slice(0, pointLimit);
}
async function loadSummary(db: DatabaseClient, filterParams: FilterParameters, identity: JobResourceIdentity): Promise<JobResourceTrendJob | null> {
  const rows = await resourceTrendQueries(db).selected.execute({ ...filterParams, ...identity });
  return rows[0] ? normalizeJob(rows[0]) : null;
}

function summaryMatchesIdentity(summary: JobResourceTrendJob, identity: JobResourceIdentity): boolean {
  return summary.repositoryId === identity.repositoryId && summary.workflowName === identity.workflowName && summary.jobName === identity.jobName;
}
function identityFromSummary(summary: JobResourceTrendJob): JobResourceIdentity {
  return { repositoryId: summary.repositoryId, workflowName: summary.workflowName, jobName: summary.jobName };
}
export async function listJobResourceTrends(db: DatabaseClient, organizationId: string, query: JobResourceTrendQuery, userId?: string): Promise<JobResourceTrendResponse> {
  const validated = validateQuery(query), filters = filterParameters(organizationId, validated, userId), cursor = validated.cursor;
  const summaryParams = { ...filters, hasCursor: cursor !== null,
    sortValue: cursor?.sortValue ?? (validated.sort === "latest" ? new Date(0).toISOString() : 0),
    cursorRepositoryId: cursor?.identity.repositoryId ?? "00000000-0000-0000-0000-000000000000",
    cursorWorkflowName: cursor?.identity.workflowName ?? "", cursorJobName: cursor?.identity.jobName ?? "", limit: validated.limit + 1 };
  const [totalRows, facetRows, summaryRows] = await Promise.all([
    resourceTrendQueries(db).totals.execute(filters),
    resourceTrendQueries(db).facets.execute(filters),
    resourceTrendQueries(db).summaries[validated.sort].execute(summaryParams),
  ]);
  const total = totalRows[0] ?? {}, completedRunCount = asNumber(total.completedRunCount), telemetryCoveredRunCount = asNumber(total.telemetryCoveredRunCount);
  const jobs = summaryRows.slice(0, validated.limit).map(normalizeJob), lastJob = jobs.at(-1);
  const nextCursor = summaryRows.length > validated.limit && lastJob
    ? encodeJobResourceCursor({ sortValue: cursorSortValue(lastJob, validated.sort), jobKey: lastJob.jobKey }) : null;
  let selectedJob: JobResourceTrendResponse["selectedJob"] = null;
  const firstSummary = jobs[0] ?? null;
  let selectedSummary = firstSummary;
  if (validated.requestedIdentity) selectedSummary = jobs.find(job => summaryMatchesIdentity(job, validated.requestedIdentity!))
    ?? await loadSummary(db, filters, validated.requestedIdentity) ?? firstSummary;
  if (selectedSummary) {
    let points = await loadPoints(db, filters, identityFromSummary(selectedSummary), validated.pointLimit);
    if (validated.requestedIdentity && points.length === 0 && firstSummary && selectedSummary.jobKey !== firstSummary.jobKey) {
      selectedSummary = firstSummary;
      points = await loadPoints(db, filters, identityFromSummary(selectedSummary), validated.pointLimit);
    }
    selectedJob = { summary: selectedSummary, points };
  }
  const facets = facetRows[0] ?? {};
  const uniqueStrings = (values: unknown): string[] => [...new Set(Array.isArray(values) ? values.map(String) : [])].sort();
  const uniqueNumbers = (values: unknown): number[] => [...new Set(Array.isArray(values) ? values.map(asNumber) : [])].sort((left, right) => left - right);
  const workers = Array.isArray(facets.workers) ? facets.workers.map(worker => worker && typeof worker === "object" ? { id: String((worker as Record<string, unknown>).id), name: String((worker as Record<string, unknown>).name) } : null)
    .filter((worker): worker is { id: string; name: string } => Boolean(worker?.id && worker?.name)).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)) : [];
  return {
    summary: { jobCount: asNumber(total.jobCount), completedRunCount, medianExecutionDurationMs: asNumber(total.medianExecutionDurationMs), telemetryCoveredRunCount,
      telemetryCoveragePercent: completedRunCount === 0 ? 0 : telemetryCoveredRunCount / completedRunCount * 100 },
    jobs, nextCursor, selectedJob, filters: { platforms: uniqueStrings(facets.platforms), vcpus: uniqueNumbers(facets.vcpus), concurrencies: uniqueNumbers(facets.concurrencies), workers }, generatedAt: new Date().toISOString(),
  };
}
