import type { JobResourceTrendJob, JobResourceTrendPoint, JobResourceTrendResponse, JobResourceTrendSort } from "@mars/contracts";
import type { DatabaseClient } from "./index.ts";

export type JobResourceTrendQuery = {
  from: string; to: string; platform?: string; vcpu?: number; concurrency?: number;
  search?: string; sort?: JobResourceTrendSort; cursor?: string | null;
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

const FILTER_PREDICATES = `
  organization_id=$1
  AND completed_at >= $2::timestamptz
  AND completed_at < $3::timestamptz
  AND ($4::text IS NULL OR platform=$4)
  AND ($5::bigint IS NULL OR requested_vcpu=$5)
  AND ($6::bigint IS NULL OR effective_concurrency=$6)
  AND ($7::text = '' OR repository_name ILIKE $7 ESCAPE '\\' OR workflow_name ILIKE $7 ESCAPE '\\' OR job_name ILIKE $7 ESCAPE '\\')`;
const FILTERED_CTE = `WITH filtered AS (
  SELECT * FROM dashboard_job_timing_snapshots
  WHERE ${FILTER_PREDICATES}
)`;
const TOTALS_SQL = `${FILTERED_CTE}
SELECT count(DISTINCT (repository_id, workflow_name, job_name))::bigint AS "jobCount",
  count(*)::bigint AS "completedRunCount",
  coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY execution_duration_ms), 0)::bigint AS "medianExecutionDurationMs",
  count(*) FILTER (WHERE telemetry_sample_count > 0)::bigint AS "telemetryCoveredRunCount"
FROM filtered`;
const FACETS_SQL = `${FILTERED_CTE}
SELECT coalesce(array_agg(DISTINCT platform ORDER BY platform), ARRAY[]::text[]) AS platforms,
  coalesce(array_agg(DISTINCT requested_vcpu ORDER BY requested_vcpu), ARRAY[]::bigint[]) AS vcpus,
  coalesce(array_agg(DISTINCT effective_concurrency ORDER BY effective_concurrency), ARRAY[]::bigint[]) AS concurrencies
FROM filtered`;
const GROUPED_CTES = `${FILTERED_CTE}, ranked AS (
  SELECT filtered.*, row_number() OVER (
    PARTITION BY repository_id, workflow_name, job_name ORDER BY completed_at DESC, job_id DESC
  ) AS identity_ordinal FROM filtered
), grouped AS (
  SELECT repository_id AS "repositoryId", max(repository_name) FILTER (WHERE identity_ordinal=1) AS "repositoryName",
    workflow_name AS "workflowName", job_name AS "jobName", max(platform) FILTER (WHERE identity_ordinal=1) AS platform,
    count(*)::bigint AS "runCount", max(completed_at) AS "latestCompletedAt",
    percentile_cont(0.5) WITHIN GROUP (ORDER BY execution_duration_ms)::bigint AS "medianExecutionDurationMs",
    max(cpu_peak_percent) AS "cpuPeakPercent", max(memory_peak_bytes)::bigint AS "memoryPeakBytes",
    count(*) FILTER (WHERE telemetry_sample_count > 0)::bigint AS "telemetryCoveredRunCount",
    max(execution_duration_ms) FILTER (WHERE identity_ordinal=1) AS latest_duration,
    max(execution_duration_ms) FILTER (WHERE identity_ordinal=2) AS previous_duration,
    max(cpu_peak_percent) FILTER (WHERE identity_ordinal=1) AS latest_cpu,
    max(cpu_peak_percent) FILTER (WHERE identity_ordinal=2) AS previous_cpu,
    max(memory_peak_bytes) FILTER (WHERE identity_ordinal=1) AS latest_memory,
    max(memory_peak_bytes) FILTER (WHERE identity_ordinal=2) AS previous_memory
  FROM ranked GROUP BY repository_id, workflow_name, job_name
), summaries AS (
  SELECT "repositoryId", "repositoryName", "workflowName", "jobName", platform,
    "runCount", "latestCompletedAt", "medianExecutionDurationMs", "cpuPeakPercent", "memoryPeakBytes", "telemetryCoveredRunCount",
    CASE WHEN latest_duration IS NULL OR previous_duration IS NULL OR previous_duration=0 THEN NULL ELSE (latest_duration - previous_duration)::numeric / previous_duration * 100 END AS "durationChangePercent",
    CASE WHEN latest_cpu IS NULL OR previous_cpu IS NULL OR previous_cpu=0 THEN NULL ELSE (latest_cpu - previous_cpu) / previous_cpu * 100 END AS "cpuChangePercent",
    CASE WHEN latest_memory IS NULL OR previous_memory IS NULL OR previous_memory=0 THEN NULL ELSE (latest_memory - previous_memory)::numeric / previous_memory * 100 END AS "memoryChangePercent"
  FROM grouped
)`;
const SUMMARY_COLUMNS = `SELECT "repositoryId", "repositoryName", "workflowName", "jobName", platform,
  "runCount", "latestCompletedAt", "medianExecutionDurationMs", "cpuPeakPercent", "memoryPeakBytes", "telemetryCoveredRunCount",
  "durationChangePercent", "cpuChangePercent", "memoryChangePercent" FROM summaries`;
const identityAfterCursor = `("repositoryId", "workflowName", "jobName") > ($10::uuid, $11::text, $12::text)`;
const SUMMARY_SQL: Record<JobResourceTrendSort, string> = {
  latest: `${GROUPED_CTES}\n${SUMMARY_COLUMNS}\nWHERE NOT $8::boolean OR "latestCompletedAt" < $9::timestamptz OR ("latestCompletedAt" = $9::timestamptz AND ${identityAfterCursor})\nORDER BY "latestCompletedAt" DESC, "repositoryId", "workflowName", "jobName"\nLIMIT $13`,
  duration: `${GROUPED_CTES}\n${SUMMARY_COLUMNS}\nWHERE NOT $8::boolean OR "medianExecutionDurationMs" < $9::numeric OR ("medianExecutionDurationMs" = $9::numeric AND ${identityAfterCursor})\nORDER BY "medianExecutionDurationMs" DESC, "repositoryId", "workflowName", "jobName"\nLIMIT $13`,
  cpu: `${GROUPED_CTES}\n${SUMMARY_COLUMNS}\nWHERE NOT $8::boolean OR coalesce("cpuPeakPercent", -1) < $9::numeric OR (coalesce("cpuPeakPercent", -1) = $9::numeric AND ${identityAfterCursor})\nORDER BY coalesce("cpuPeakPercent", -1) DESC, "repositoryId", "workflowName", "jobName"\nLIMIT $13`,
  memory: `${GROUPED_CTES}\n${SUMMARY_COLUMNS}\nWHERE NOT $8::boolean OR coalesce("memoryPeakBytes", -1) < $9::numeric OR (coalesce("memoryPeakBytes", -1) = $9::numeric AND ${identityAfterCursor})\nORDER BY coalesce("memoryPeakBytes", -1) DESC, "repositoryId", "workflowName", "jobName"\nLIMIT $13`,
  runs: `${GROUPED_CTES}\n${SUMMARY_COLUMNS}\nWHERE NOT $8::boolean OR "runCount" < $9::numeric OR ("runCount" = $9::numeric AND ${identityAfterCursor})\nORDER BY "runCount" DESC, "repositoryId", "workflowName", "jobName"\nLIMIT $13`,
};
const POINTS_SQL = `${FILTERED_CTE}, ordered AS (
  SELECT organization_id AS "organizationId", run_id AS "runId", job_id AS "jobId", completed_at AS "completedAt", outcome,
    execution_duration_ms AS "executionDurationMs", cpu_average_percent AS "cpuAveragePercent", cpu_peak_percent AS "cpuPeakPercent",
    memory_peak_bytes AS "memoryPeakBytes", requested_vcpu AS "requestedVcpu", requested_memory_bytes AS "requestedMemoryBytes",
    effective_concurrency AS "effectiveConcurrency", telemetry_state AS "telemetryState", telemetry_sample_count AS "telemetrySampleCount",
    row_number() OVER (ORDER BY completed_at, job_id) AS ordinal, count(*) OVER () AS total
  FROM filtered WHERE repository_id=$8 AND workflow_name=$9 AND job_name=$10
), targets AS (
  SELECT DISTINCT CASE WHEN total <= $11 THEN target_index WHEN $11=1 THEN 1
    ELSE round(1 + (target_index - 1) * (total - 1)::numeric / ($11 - 1))::bigint END AS ordinal
  FROM (SELECT max(total)::bigint AS total FROM ordered) counts
  CROSS JOIN LATERAL generate_series(1::bigint, least(total, $11::bigint)) AS generated(target_index)
  WHERE total > 0
)
SELECT "organizationId", "runId", "jobId", "completedAt", outcome, "executionDurationMs", "cpuAveragePercent", "cpuPeakPercent",
  "memoryPeakBytes", "requestedVcpu", "requestedMemoryBytes", "effectiveConcurrency", "telemetryState", "telemetrySampleCount"
FROM ordered JOIN targets USING (ordinal)
ORDER BY ordered."completedAt", ordered."jobId"
LIMIT $11`;

type ValidatedQuery = {
  from: string; to: string; platform: string | null; vcpu: number | null; concurrency: number | null;
  searchPattern: string; sort: JobResourceTrendSort;
  cursor: (JobResourceCursor & { identity: JobResourceIdentity }) | null;
  limit: number; requestedIdentity: JobResourceIdentity | null; pointLimit: number;
};
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
const uuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new JobResourceTrendInputError();
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}
function searchPattern(value: string): string { return value ? `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%` : ""; }
function validateQuery(query: JobResourceTrendQuery): ValidatedQuery {
  const fromMs = Date.parse(query.from), toMs = Date.parse(query.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new JobResourceTrendInputError();
  if (query.vcpu !== undefined && !positiveInteger(query.vcpu)) throw new JobResourceTrendInputError();
  if (query.concurrency !== undefined && !positiveInteger(query.concurrency)) throw new JobResourceTrendInputError();
  if (query.platform !== undefined && typeof query.platform !== "string") throw new JobResourceTrendInputError();
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
    vcpu: query.vcpu ?? null, concurrency: query.concurrency ?? null, searchPattern: searchPattern(query.search ?? ""), sort, cursor,
    limit: normalizeLimit(query.limit, 50, 100), requestedIdentity, pointLimit: normalizeLimit(query.pointLimit, 100, 200),
  };
}
type SqlParameter = string | number | boolean | null;
function filterParameters(organizationId: string, query: ValidatedQuery): SqlParameter[] {
  return [organizationId, query.from, query.to, query.platform, query.vcpu, query.concurrency, query.searchPattern];
}
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
    latestCompletedAt: asIso(row.latestCompletedAt), medianExecutionDurationMs: asNumber(row.medianExecutionDurationMs),
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
async function loadPoints(db: DatabaseClient, filterParams: SqlParameter[], identity: JobResourceIdentity, pointLimit: number): Promise<JobResourceTrendPoint[]> {
  const rows = await db.unsafe<Record<string, unknown>[]>(POINTS_SQL, [...filterParams, identity.repositoryId, identity.workflowName, identity.jobName, pointLimit]);
  return rows.map(normalizePoint).sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.jobId.localeCompare(right.jobId)).slice(0, pointLimit);
}

export async function listJobResourceTrends(db: DatabaseClient, organizationId: string, query: JobResourceTrendQuery): Promise<JobResourceTrendResponse> {
  const validated = validateQuery(query), filters = filterParameters(organizationId, validated), cursor = validated.cursor;
  const summaryParams = [...filters, cursor !== null, cursor?.sortValue ?? (validated.sort === "latest" ? new Date(0).toISOString() : 0),
    cursor?.identity.repositoryId ?? "00000000-0000-0000-0000-000000000000", cursor?.identity.workflowName ?? "", cursor?.identity.jobName ?? "", validated.limit + 1];
  const [totalRows, facetRows, summaryRows] = await Promise.all([
    db.unsafe<Record<string, unknown>[]>(TOTALS_SQL, filters),
    db.unsafe<Record<string, unknown>[]>(FACETS_SQL, filters),
    db.unsafe<Record<string, unknown>[]>(SUMMARY_SQL[validated.sort], summaryParams),
  ]);
  const total = totalRows[0] ?? {}, completedRunCount = asNumber(total.completedRunCount), telemetryCoveredRunCount = asNumber(total.telemetryCoveredRunCount);
  const jobs = summaryRows.slice(0, validated.limit).map(normalizeJob), lastJob = jobs.at(-1);
  const nextCursor = summaryRows.length > validated.limit && lastJob
    ? encodeJobResourceCursor({ sortValue: cursorSortValue(lastJob, validated.sort), jobKey: lastJob.jobKey }) : null;
  let selectedJob: JobResourceTrendResponse["selectedJob"] = null;
  const firstIdentity = summaryRows[0] ? identityFromRow(summaryRows[0]) : null;
  let selectedIdentity = validated.requestedIdentity ?? firstIdentity;
  if (selectedIdentity) {
    let points = await loadPoints(db, filters, selectedIdentity, validated.pointLimit);
    if (validated.requestedIdentity && points.length === 0 && firstIdentity
      && encodeJobResourceKey(selectedIdentity) !== encodeJobResourceKey(firstIdentity)) {
      selectedIdentity = firstIdentity;
      points = await loadPoints(db, filters, selectedIdentity, validated.pointLimit);
    }
    if (points.length > 0 || firstIdentity) selectedJob = { jobKey: encodeJobResourceKey(selectedIdentity), points };
  }
  const facets = facetRows[0] ?? {};
  const uniqueStrings = (values: unknown): string[] => [...new Set(Array.isArray(values) ? values.map(String) : [])].sort();
  const uniqueNumbers = (values: unknown): number[] => [...new Set(Array.isArray(values) ? values.map(asNumber) : [])].sort((left, right) => left - right);
  return {
    summary: { jobCount: asNumber(total.jobCount), completedRunCount, medianExecutionDurationMs: asNumber(total.medianExecutionDurationMs), telemetryCoveredRunCount,
      telemetryCoveragePercent: completedRunCount === 0 ? 0 : telemetryCoveredRunCount / completedRunCount * 100 },
    jobs, nextCursor, selectedJob,
    filters: { platforms: uniqueStrings(facets.platforms), vcpus: uniqueNumbers(facets.vcpus), concurrencies: uniqueNumbers(facets.concurrencies) },
    generatedAt: new Date().toISOString(),
  };
}
