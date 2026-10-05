import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";

export const resourceTrendQueries = defineQueries(db => {
  const s = schema.dashboardJobTimingSnapshots, p = sql.placeholder;
  const fields = {
    organizationId: s.organizationId, runId: s.runId, jobId: s.jobId, repositoryId: s.repositoryId,
    repositoryName: s.repositoryName, workflowName: s.workflowName, jobName: s.jobName, platform: s.platform,
    completedAt: s.completedAt, outcome: s.outcome, executionDurationMs: s.executionDurationMs,
    cpuAveragePercent: s.cpuAveragePercent, cpuPeakPercent: s.cpuPeakPercent, memoryPeakBytes: s.memoryPeakBytes,
    requestedVcpu: s.requestedVcpu, requestedMemoryBytes: s.requestedMemoryBytes,
    effectiveConcurrency: s.effectiveConcurrency, telemetryState: s.telemetryState, telemetrySampleCount: s.telemetrySampleCount, workerId: s.workerId,
  };
  function filter(includeWorker: boolean) {
    // Each placeholder occurrence binds separately; keep "all" text-typed until CASE selects the UUID branch.
    return and(
      sql`((${p("organizationId")}::text='all' AND ${s.organizationId} IN (${db.select({ organizationId: schema.memberships.organizationId }).from(schema.memberships).where(eq(schema.memberships.userId, sql`${p("userId")}::uuid`))})) OR (${p("organizationId")}::text<>'all' AND ${s.organizationId}=CASE WHEN ${p("organizationId")}::text='all' THEN NULL ELSE ${p("organizationId")}::text::uuid END))`,
      sql`${s.completedAt}>=${p("from")}::timestamptz AND ${s.completedAt}<${p("to")}::timestamptz`,
      sql`(${p("platform")}::text IS NULL OR ${s.platform}=${p("platform")}::text)`,
      sql`(${p("vcpu")}::bigint IS NULL OR ${s.requestedVcpu}=${p("vcpu")}::bigint)`,
      sql`(${p("concurrency")}::bigint IS NULL OR ${s.effectiveConcurrency}=${p("concurrency")}::bigint)`,
      sql`(${p("search")}::text='' OR ${s.repositoryName} ILIKE ${p("search")}::text ESCAPE '\\' OR ${s.workflowName} ILIKE ${p("search")}::text ESCAPE '\\' OR ${s.jobName} ILIKE ${p("search")}::text ESCAPE '\\')`,
      includeWorker ? sql`(${p("workerId")}::uuid IS NULL OR ${s.workerId}=${p("workerId")}::uuid)` : undefined,
    );
  }
  const filtered = db.$with("trend_filtered").as(db.select(fields).from(s).where(filter(true)));
  const facetFiltered = db.$with("trend_facets_filtered").as(db.select(fields).from(s).where(filter(false)));
  const ranked = db.$with("trend_ranked").as(db.select({
    repositoryId: filtered.repositoryId, repositoryName: filtered.repositoryName,
    workflowName: filtered.workflowName, jobName: filtered.jobName, platform: filtered.platform,
    completedAt: filtered.completedAt, requestedVcpu: filtered.requestedVcpu,
    requestedMemoryBytes: filtered.requestedMemoryBytes, effectiveConcurrency: filtered.effectiveConcurrency,
    executionDurationMs: filtered.executionDurationMs, cpuPeakPercent: filtered.cpuPeakPercent,
    memoryPeakBytes: filtered.memoryPeakBytes, telemetrySampleCount: filtered.telemetrySampleCount,
    identityOrdinal: sql<number>`row_number() OVER (PARTITION BY ${filtered.repositoryId},${filtered.workflowName},${filtered.jobName} ORDER BY ${filtered.completedAt} DESC,${filtered.jobId} DESC)`.as("identity_ordinal"),
  }).from(filtered));
  const grouped = db.$with("trend_grouped").as(db.select({
    repositoryId: ranked.repositoryId, workflowName: ranked.workflowName, jobName: ranked.jobName,
    repositoryName: sql<string>`max(${ranked.repositoryName}) FILTER (WHERE ${ranked.identityOrdinal}=1)`.as("repository_name"),
    platform: sql<string>`max(${ranked.platform}) FILTER (WHERE ${ranked.identityOrdinal}=1)`.as("platform"),
    runCount: sql<number>`count(*)::bigint`.as("run_count"), latestCompletedAt: sql<string>`max(${ranked.completedAt})`.as("latest_completed_at"),
    latestRequestedVcpu: sql<number>`max(${ranked.requestedVcpu}) FILTER (WHERE ${ranked.identityOrdinal}=1)::bigint`.as("latest_requested_vcpu"),
    latestRequestedMemoryBytes: sql<number>`max(${ranked.requestedMemoryBytes}) FILTER (WHERE ${ranked.identityOrdinal}=1)::bigint`.as("latest_requested_memory_bytes"),
    latestEffectiveConcurrency: sql<number>`max(${ranked.effectiveConcurrency}) FILTER (WHERE ${ranked.identityOrdinal}=1)::bigint`.as("latest_effective_concurrency"),
    medianExecutionDurationMs: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${ranked.executionDurationMs})::bigint`.as("median_execution_duration_ms"),
    cpuPeakPercent: sql<number | null>`max(${ranked.cpuPeakPercent})`.as("cpu_peak_percent"),
    memoryPeakBytes: sql<number | null>`max(${ranked.memoryPeakBytes})::bigint`.as("memory_peak_bytes"),
    telemetryCoveredRunCount: sql<number>`count(*) FILTER (WHERE ${ranked.telemetrySampleCount}>0)::bigint`.as("telemetry_covered_run_count"),
    latestDuration: sql<number | null>`max(${ranked.executionDurationMs}) FILTER (WHERE ${ranked.identityOrdinal}=1)`.as("latest_duration"),
    previousDuration: sql<number | null>`max(${ranked.executionDurationMs}) FILTER (WHERE ${ranked.identityOrdinal}=2)`.as("previous_duration"),
    latestCpu: sql<number | null>`max(${ranked.cpuPeakPercent}) FILTER (WHERE ${ranked.identityOrdinal}=1)`.as("latest_cpu"),
    previousCpu: sql<number | null>`max(${ranked.cpuPeakPercent}) FILTER (WHERE ${ranked.identityOrdinal}=2)`.as("previous_cpu"),
    latestMemory: sql<number | null>`max(${ranked.memoryPeakBytes}) FILTER (WHERE ${ranked.identityOrdinal}=1)`.as("latest_memory"),
    previousMemory: sql<number | null>`max(${ranked.memoryPeakBytes}) FILTER (WHERE ${ranked.identityOrdinal}=2)`.as("previous_memory"),
  }).from(ranked).groupBy(ranked.repositoryId, ranked.workflowName, ranked.jobName));
  const change = (latest: SQL.Aliased, previous: SQL.Aliased) => sql<number | null>`CASE WHEN ${latest} IS NULL OR ${previous} IS NULL OR ${previous}=0 THEN NULL ELSE (${latest}-${previous})::numeric/${previous}*100 END`;
  const summaryFields = {
    repositoryId: grouped.repositoryId, repositoryName: grouped.repositoryName, workflowName: grouped.workflowName, jobName: grouped.jobName,
    platform: grouped.platform, runCount: grouped.runCount, latestCompletedAt: grouped.latestCompletedAt,
    latestRequestedVcpu: grouped.latestRequestedVcpu, latestRequestedMemoryBytes: grouped.latestRequestedMemoryBytes,
    latestEffectiveConcurrency: grouped.latestEffectiveConcurrency, medianExecutionDurationMs: grouped.medianExecutionDurationMs,
    cpuPeakPercent: grouped.cpuPeakPercent, memoryPeakBytes: grouped.memoryPeakBytes, telemetryCoveredRunCount: grouped.telemetryCoveredRunCount,
    durationChangePercent: change(grouped.latestDuration, grouped.previousDuration),
    cpuChangePercent: change(grouped.latestCpu, grouped.previousCpu), memoryChangePercent: change(grouped.latestMemory, grouped.previousMemory),
  };
  function summaryPage(sort: "latest" | "duration" | "cpu" | "memory" | "runs") {
    const value = sort === "latest" ? grouped.latestCompletedAt : sort === "duration" ? grouped.medianExecutionDurationMs : sort === "cpu" ? sql`coalesce(${grouped.cpuPeakPercent},-1)` : sort === "memory" ? sql`coalesce(${grouped.memoryPeakBytes},-1)` : grouped.runCount;
    const cursorValue = sort === "latest" ? sql`${p("sortValue")}::timestamptz` : sql`${p("sortValue")}::numeric`;
    return db.with(filtered, ranked, grouped).select(summaryFields).from(grouped).where(sql`NOT ${p("hasCursor")}::boolean OR ${value}<${cursorValue} OR (${value}=${cursorValue} AND (${grouped.repositoryId},${grouped.workflowName},${grouped.jobName})>(${p("cursorRepositoryId")}::uuid,${p("cursorWorkflowName")}::text,${p("cursorJobName")}::text))`)
      .orderBy(desc(value), asc(grouped.repositoryId), asc(grouped.workflowName), asc(grouped.jobName)).limit(p("limit")).prepare(`resource_trends_summary_${sort}`);
  }
  const selectedIdentity = and(eq(filtered.repositoryId, p("repositoryId")), eq(filtered.workflowName, p("workflowName")), eq(filtered.jobName, p("jobName")));
  const pointFields = {
    organizationId: filtered.organizationId, runId: filtered.runId, jobId: filtered.jobId, completedAt: filtered.completedAt,
    outcome: filtered.outcome, executionDurationMs: filtered.executionDurationMs, cpuAveragePercent: filtered.cpuAveragePercent,
    cpuPeakPercent: filtered.cpuPeakPercent, memoryPeakBytes: filtered.memoryPeakBytes, requestedVcpu: filtered.requestedVcpu,
    requestedMemoryBytes: filtered.requestedMemoryBytes, effectiveConcurrency: filtered.effectiveConcurrency,
    telemetryState: filtered.telemetryState, telemetrySampleCount: filtered.telemetrySampleCount,
  };
  const ordered = db.$with("trend_ordered").as(db.select({ ...pointFields,
    ordinal: sql<number>`row_number() OVER (ORDER BY ${filtered.completedAt},${filtered.jobId})`.as("ordinal"),
    total: sql<number>`count(*) OVER ()`.as("total"),
  }).from(filtered).where(selectedIdentity));
  const counts = db.$with("trend_counts").as(db.select({ total: sql<number>`max(${ordered.total})::bigint`.as("total") }).from(ordered));
  // PostgreSQL set-returning generate_series is an intentional SQL FROM fragment.
  const targets = db.$with("trend_targets").as(db.selectDistinct({ ordinal: sql<number>`CASE WHEN ${counts.total}<=${p("pointLimit")}::bigint THEN generated.target_index ELSE round(1+(generated.target_index-1)*(${counts.total}-1)::numeric/(${p("pointLimit")}::bigint-1))::bigint END`.as("target_ordinal") })
    .from(counts).crossJoinLateral(sql`generate_series(1::bigint,least(${counts.total},${p("pointLimit")}::bigint)) AS generated(target_index)`).where(sql`${counts.total}>0`));
  const eligibleWorkers = db.selectDistinct({ workerId: facetFiltered.workerId }).from(facetFiltered);
  const workers = db.select({ workers: sql<unknown[]>`jsonb_agg(jsonb_build_object('id',${schema.workers.id},'name',${schema.workers.name}) ORDER BY ${schema.workers.name},${schema.workers.id})` }).from(schema.workers).where(inArray(schema.workers.id, eligibleWorkers));
  return {
    totals: db.with(filtered).select({ jobCount: sql<number>`count(DISTINCT (${filtered.repositoryId},${filtered.workflowName},${filtered.jobName}))::bigint`, completedRunCount: sql<number>`count(*)::bigint`, medianExecutionDurationMs: sql<number>`coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${filtered.executionDurationMs}),0)::bigint`, telemetryCoveredRunCount: sql<number>`count(*) FILTER (WHERE ${filtered.telemetrySampleCount}>0)::bigint` }).from(filtered).prepare("resource_trends_totals"),
    facets: db.with(facetFiltered).select({ platforms: sql<string[]>`coalesce(array_agg(DISTINCT ${facetFiltered.platform} ORDER BY ${facetFiltered.platform}),ARRAY[]::text[])`, vcpus: sql<number[]>`coalesce(array_agg(DISTINCT ${facetFiltered.requestedVcpu} ORDER BY ${facetFiltered.requestedVcpu}),ARRAY[]::bigint[])`, concurrencies: sql<number[]>`coalesce(array_agg(DISTINCT ${facetFiltered.effectiveConcurrency} ORDER BY ${facetFiltered.effectiveConcurrency}),ARRAY[]::bigint[])`, workers: sql<unknown[]>`coalesce((${workers}),'[]'::jsonb)` }).from(facetFiltered).prepare("resource_trends_facets"),
    summaries: { latest: summaryPage("latest"), duration: summaryPage("duration"), cpu: summaryPage("cpu"), memory: summaryPage("memory"), runs: summaryPage("runs") },
    selected: db.with(filtered, ranked, grouped).select(summaryFields).from(grouped).where(and(eq(grouped.repositoryId, p("repositoryId")), eq(grouped.workflowName, p("workflowName")), eq(grouped.jobName, p("jobName")))).limit(1).prepare("resource_trends_selected"),
    points: db.with(filtered, ordered, counts, targets).select({
      organizationId: ordered.organizationId, runId: ordered.runId, jobId: ordered.jobId, completedAt: ordered.completedAt, outcome: ordered.outcome,
      executionDurationMs: ordered.executionDurationMs, cpuAveragePercent: ordered.cpuAveragePercent, cpuPeakPercent: ordered.cpuPeakPercent,
      memoryPeakBytes: ordered.memoryPeakBytes, requestedVcpu: ordered.requestedVcpu, requestedMemoryBytes: ordered.requestedMemoryBytes,
      effectiveConcurrency: ordered.effectiveConcurrency, telemetryState: ordered.telemetryState, telemetrySampleCount: ordered.telemetrySampleCount,
    }).from(ordered).innerJoin(targets, eq(ordered.ordinal, targets.ordinal)).orderBy(asc(ordered.completedAt), asc(ordered.jobId)).limit(p("pointLimit")).prepare("resource_trends_points"),
  };
});
