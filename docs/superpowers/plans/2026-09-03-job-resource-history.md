# Job Resource History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/runs/timing` with a job-oriented operational view of CPU, memory, and execution-duration trends over time.

**Architecture:** Add a validated job-resource-trends read contract and a server-side aggregation query so the browser never downloads all raw timing rows. The React page owns filters and selection, renders a paginated job list, and passes one selected job’s normalized run points into three focused TanStack Charts components plus an accessible table.

**Tech Stack:** Bun, TypeScript, PostgreSQL, Hono, Zod, React 19, TanStack Query, TanStack Charts 0.11, TanStack Router, CSS.

## Global Constraints

- Work directly on `main`; commit and push each independently complete task to `main`.
- Use the existing `@tanstack/charts` dependency and public APIs only: `Chart`, `defineChart`, `lineY`, `barY`, scales, and tooltip plugin.
- Job identity is repository ID + workflow name + job name; identical display names from different identities must not merge.
- Default range is 7 days; supported controls are 24 hours, 7 days, 30 days, and 90 days.
- CPU is blue, memory is Mars orange, duration is neutral sand, and failure/degraded telemetry is pink.
- Display CPU, memory, and duration only. Do not imply per-job disk telemetry exists.
- Format primary measurements as percentages, IEC bytes, and readable durations; do not display raw bytes or milliseconds.
- Missing resource values are unavailable/gaps, never zero.
- Initial, refreshing, empty, no-match, partial-telemetry, stale-data, and error states must remain distinct.
- A 90-day view must not require the browser to download every raw timing snapshot.
- Preserve existing `/job-timings` and `/job-timings/aggregates` consumers.

---

## File Structure

### Contracts and server

- Modify `packages/contracts/src/dashboard.ts`: define job-resource trend query/result DTOs.
- Modify `packages/contracts/src/dashboard-api.ts`: export the new DTOs and types.
- Modify `packages/contracts/src/dashboard-api.test.ts`: lock response validation and missing-value behavior.
- Create `packages/db/src/job-resource-trends.ts`: stable key/cursor codecs, grouping query, totals, filters, selected-run points, and normalization.
- Create `packages/db/src/job-resource-trends.test.ts`: query behavior, numeric normalization, identity separation, ordering, and point limiting.
- Modify `packages/db/src/index.ts`: export the new database module.
- Modify `apps/control-plane/src/http/dashboard-routes.ts`: validate the endpoint query, authorize it, invoke the database function, and validate its response.
- Modify `apps/control-plane/src/dashboard-api.test.ts`: cover authorization and query validation at the HTTP boundary.

### Web application

- Modify `apps/web/src/api.ts`: add the typed job-resource-trends request.
- Create `apps/web/src/routes/timing-model.ts`: range conversion, formatters, sorting labels, and selection rules.
- Create `apps/web/src/routes/timing-model.test.ts`: deterministic unit tests for presentation behavior.
- Create `apps/web/src/components/TimingToolbar.tsx`: filters, reset, refresh, and update status.
- Create `apps/web/src/components/TimingSummary.tsx`: four dataset facts.
- Create `apps/web/src/components/JobResourceList.tsx`: paginated summaries, sorting, warnings, and selection.
- Create `apps/web/src/components/JobResourceCharts.tsx`: CPU, memory, and duration TanStack chart components.
- Create `apps/web/src/components/JobRunMeasurements.tsx`: accessible measurements and run links.
- Create `apps/web/src/components/JobResourceDetail.tsx`: selected-job metadata, warnings, charts, and table.
- Create `apps/web/src/components/JobResourceHistory.test.tsx`: render-level behavior and accessibility coverage for the new components.
- Modify `apps/web/src/routes/TimingHistoryPage.tsx`: compose queries, filters, pagination, selected job, and selected run.
- Create `apps/web/src/routes/TimingHistoryPage.test.tsx`: page query/default/filter contract.
- Modify `apps/web/src/styles.css`: responsive resource-history layout and chart/list states.

---

### Task 1: Define the job-resource trend contract

**Files:**
- Modify: `packages/contracts/src/dashboard.ts:55-75`
- Modify: `packages/contracts/src/dashboard-api.ts:2-22,91-122`
- Modify: `packages/contracts/src/dashboard-api.test.ts`

**Interfaces:**
- Produces: `JobResourceTrendSort`, `JobResourceTrendPoint`, `JobResourceTrendJob`, `JobResourceTrendResponse`, and their inferred TypeScript types.
- `JobResourceTrendResponse` is consumed by the database result, Hono response validation, and web API client.

- [ ] **Step 1: Write failing contract tests**

Add a valid response fixture and assertions that nullable telemetry parses without coercing missing values to zero. Include two summaries with the same job name but different keys/repositories. Add rejection assertions for a disk metric and malformed percentages.

```ts
import { JobResourceTrendResponse } from "./dashboard.ts";

const trendResponse = {
  summary: { jobCount: 2, completedRunCount: 3, medianExecutionDurationMs: 62000, telemetryCoveredRunCount: 2, telemetryCoveragePercent: 66.67 },
  jobs: [{
    jobKey: "eyJyZXBvc2l0b3J5SWQiOiJyZXBvLTEiLCJ3b3JrZmxvd05hbWUiOiJDSSIsImpvYk5hbWUiOiJidWlsZCJ9",
    repositoryId: "repo-1", repositoryName: "acme/app", workflowName: "CI", jobName: "build",
    platform: "windows-x64", runCount: 2, latestCompletedAt: "2026-09-03T12:00:00.000Z",
    medianExecutionDurationMs: 62000, cpuPeakPercent: 84.5, memoryPeakBytes: 2147483648,
    telemetryCoveredRunCount: 2, telemetryCoveragePercent: 100,
    durationChangePercent: 12.5, cpuChangePercent: null, memoryChangePercent: -4.2,
  }],
  nextCursor: null,
  selectedJob: {
    jobKey: "eyJyZXBvc2l0b3J5SWQiOiJyZXBvLTEiLCJ3b3JrZmxvd05hbWUiOiJDSSIsImpvYk5hbWUiOiJidWlsZCJ9",
    points: [{
      organizationId: "org-1", runId: "run-1", jobId: "job-1", completedAt: "2026-09-03T12:00:00.000Z",
      outcome: "success", executionDurationMs: 62000, cpuAveragePercent: 42.5, cpuPeakPercent: 84.5,
      memoryPeakBytes: 2147483648, requestedVcpu: 2, requestedMemoryBytes: 4294967296,
      effectiveConcurrency: 1, telemetryState: "available", telemetrySampleCount: 12,
    }],
  },
  filters: { platforms: ["windows-x64"], vcpus: [2], concurrencies: [1] },
  generatedAt: "2026-09-03T12:01:00.000Z",
};

test("accepts job resource trend values and nullable missing telemetry", () => {
  expect(JobResourceTrendResponse.parse(trendResponse).selectedJob?.points[0]?.cpuPeakPercent).toBe(84.5);
  expect(JobResourceTrendResponse.parse({
    ...trendResponse,
    selectedJob: { ...trendResponse.selectedJob, points: [{ ...trendResponse.selectedJob.points[0], cpuAveragePercent: null, cpuPeakPercent: null, memoryPeakBytes: null, telemetryState: "unavailable", telemetrySampleCount: 0 }] },
  }).selectedJob?.points[0]?.memoryPeakBytes).toBeNull();
});

test("rejects unsupported disk telemetry and invalid coverage", () => {
  expect(() => JobResourceTrendResponse.parse({ ...trendResponse, diskUsageBytes: 1 })).toThrow();
  expect(() => JobResourceTrendResponse.parse({ ...trendResponse, summary: { ...trendResponse.summary, telemetryCoveragePercent: 101 } })).toThrow();
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `bun test packages/contracts/src/dashboard-api.test.ts`

Expected: FAIL because `JobResourceTrendResponse` is not exported.

- [ ] **Step 3: Add strict DTOs and exports**

Define the contract in `dashboard.ts`. Reuse the existing timestamp, outcome, safe integer, DTO secret-rejection, and strict-object patterns.

```ts
export const JobResourceTrendSort = z.enum(["latest", "duration", "cpu", "memory", "runs"]);
export type JobResourceTrendSort = z.infer<typeof JobResourceTrendSort>;

const nullablePercent = z.number().min(0).max(100).nullable();
const nullableDelta = z.number().finite().nullable();

export const JobResourceTrendPoint = dto(strict({
  organizationId, runId: id, jobId: id, completedAt: timestamp, outcome: timingOutcome,
  executionDurationMs: timingDuration,
  cpuAveragePercent: nullablePercent,
  cpuPeakPercent: nullablePercent,
  memoryPeakBytes: nonnegativeSafe.nullable(),
  requestedVcpu: positiveSafe,
  requestedMemoryBytes: positiveSafe,
  effectiveConcurrency: positiveSafe,
  telemetryState: z.enum(["available", "partial", "unavailable"]),
  telemetrySampleCount: nonnegativeSafe,
}));

export const JobResourceTrendJob = dto(strict({
  jobKey: cursor,
  repositoryId: id,
  repositoryName: z.string().min(1), workflowName: z.string().min(1), jobName: z.string().min(1),
  platform: z.string().min(1), runCount: positiveSafe, latestCompletedAt: timestamp,
  medianExecutionDurationMs: timingDuration,
  cpuPeakPercent: nullablePercent, memoryPeakBytes: nonnegativeSafe.nullable(),
  telemetryCoveredRunCount: nonnegativeSafe, telemetryCoveragePercent: z.number().min(0).max(100),
  durationChangePercent: nullableDelta, cpuChangePercent: nullableDelta, memoryChangePercent: nullableDelta,
}));

export const JobResourceTrendResponse = dto(strict({
  summary: strict({
    jobCount: nonnegativeSafe, completedRunCount: nonnegativeSafe,
    medianExecutionDurationMs: timingDuration,
    telemetryCoveredRunCount: nonnegativeSafe,
    telemetryCoveragePercent: z.number().min(0).max(100),
  }),
  jobs: z.array(JobResourceTrendJob), nextCursor: cursor.nullable(),
  selectedJob: strict({ jobKey: cursor, points: z.array(JobResourceTrendPoint) }).nullable(),
  filters: strict({ platforms: z.array(z.string().min(1)), vcpus: z.array(positiveSafe), concurrencies: z.array(positiveSafe) }),
  generatedAt: timestamp,
}));
```

Export the schemas and inferred types through `dashboard-api.ts`.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `bun test packages/contracts/src/dashboard-api.test.ts && bun run --cwd packages/contracts typecheck`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add packages/contracts/src/dashboard.ts packages/contracts/src/dashboard-api.ts packages/contracts/src/dashboard-api.test.ts
git commit -m "feat(contracts): define job resource trends"
git push origin main
```

---

### Task 2: Aggregate job summaries and selected-job points

**Files:**
- Create: `packages/db/src/job-resource-trends.ts`
- Create: `packages/db/src/job-resource-trends.test.ts`
- Modify: `packages/db/src/index.ts:100-110`

**Interfaces:**
- Consumes: `JobResourceTrendResponse`, `JobResourceTrendJob`, `JobResourceTrendPoint`, and `JobResourceTrendSort` from Task 1.
- Produces:

```ts
export type JobResourceTrendQuery = {
  from: string; to: string; platform?: string; vcpu?: number; concurrency?: number;
  search?: string; sort?: JobResourceTrendSort; cursor?: string | null;
  limit?: number; jobKey?: string; pointLimit?: number;
};
export function listJobResourceTrends(
  db: DatabaseClient,
  organizationId: string,
  query: JobResourceTrendQuery,
): Promise<JobResourceTrendResponse>;
```

- [ ] **Step 1: Write failing codec and normalization tests**

Test stable round trips for a job identity and cursor. Test malformed keys/cursors return `null` instead of becoming SQL input.

```ts
const identity = { repositoryId: "repo-1", workflowName: "CI", jobName: "build" };
expect(decodeJobResourceKey(encodeJobResourceKey(identity))).toEqual(identity);
expect(decodeJobResourceKey("not-json")).toBeNull();
expect(decodeJobResourceCursor(encodeJobResourceCursor({ sortValue: "2026-09-03T12:00:00.000Z", jobKey: encodeJobResourceKey(identity) }))).toMatchObject({ jobKey: encodeJobResourceKey(identity) });
```

Then use a query-recording fake database with one result set per database call. Supply PostgreSQL `bigint` and `numeric` values as strings. Assert the public result contains JavaScript numbers, distinct repository identities, ascending selected points, and at most the requested point limit.

- [ ] **Step 2: Run the new database test and verify RED**

Run: `bun test packages/db/src/job-resource-trends.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement stable opaque codecs**

Use base64url-encoded JSON and validate decoded objects before use.

```ts
const JobIdentity = z.object({ repositoryId: z.string().min(1), workflowName: z.string().min(1), jobName: z.string().min(1) }).strict();
const JobCursor = z.object({ sortValue: z.union([z.string(), z.number()]), jobKey: z.string().min(1) }).strict();

export const encodeJobResourceKey = (identity: z.infer<typeof JobIdentity>) => Buffer.from(JSON.stringify(JobIdentity.parse(identity))).toString("base64url");
export function decodeJobResourceKey(value: string) {
  try { return JobIdentity.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
  catch { return null; }
}
```

Implement equivalent `encodeJobResourceCursor` and `decodeJobResourceCursor` functions. Reject an invalid supplied `jobKey` or cursor with a typed input error consumed by the HTTP layer; never silently reinterpret malformed client input.

- [ ] **Step 4: Implement filtered totals, filter facets, and grouped summaries**

Build all statements from one shared set of SQL predicates over `dashboard_job_timing_snapshots`: organization, completed range, platform, requested vCPU, effective concurrency, and case-insensitive repository/workflow/job search. Do not interpolate column names or sort directions from input. Select one of five static summary queries based on the validated sort enum.

The grouped summary must calculate:

```sql
count(*)::bigint AS run_count,
max(completed_at) AS latest_completed_at,
percentile_cont(0.5) WITHIN GROUP (ORDER BY execution_duration_ms)::bigint AS median_execution_duration_ms,
max(cpu_peak_percent) AS cpu_peak_percent,
max(memory_peak_bytes)::bigint AS memory_peak_bytes,
count(*) FILTER (WHERE telemetry_sample_count > 0)::bigint AS telemetry_covered_run_count
```

Use window ordering by `completed_at DESC` inside each identity to obtain latest and previous values. Calculate each change as `(latest - previous) / previous * 100`; return `null` when either value is absent or the previous value is zero. Apply deterministic secondary ordering by repository ID, workflow name, and job name. Fetch `limit + 1`, emit at most `limit`, and encode the last emitted sort value plus job key as `nextCursor`.

Run totals, facets, and job summaries concurrently after validating the query. Facets are sorted unique arrays. Coverage is `covered / completed * 100`, or `0` when no completed rows exist.

- [ ] **Step 5: Implement selected-job point retrieval and server-side limiting**

Select the requested valid identity, or the first summary identity when `jobKey` is omitted or filtered out. Query only that identity and the active filters. Keep numeric values nullable through normalization.

Use SQL ordinal sampling rather than returning every row to Bun. A CTE assigns `row_number()` and total count, then retains ordinals nearest to evenly spaced target positions. Always retain ordinal 1 and the final ordinal; order the final rows by completion time ascending. Cap `pointLimit` to 1–200, defaulting to 100.

```sql
WITH ordered AS (
  SELECT ..., row_number() OVER (ORDER BY completed_at, job_id) AS ordinal,
         count(*) OVER () AS total
  FROM dashboard_job_timing_snapshots
  WHERE ...identity and active filters...
), targets AS (
  SELECT DISTINCT round(value)::bigint AS ordinal
  FROM ordered, LATERAL generate_series(1, greatest(total, 1), greatest(1, ceil(total::numeric / $point_limit)::int)) AS value
)
SELECT ordered.* FROM ordered
JOIN targets USING (ordinal)
ORDER BY completed_at, job_id
LIMIT $point_limit
```

If this stride form does not preserve the final row under the limit, union ordinal `total`, rank the combined set by distance to evenly spaced targets, and trim without dropping first/final. Lock the exact behavior with tests for 0, 1, 2, 201, and 1000 input rows.

- [ ] **Step 6: Export and verify the database module**

Add `export * from "./job-resource-trends.ts";` to `packages/db/src/index.ts`.

Run: `bun test packages/db/src/job-resource-trends.test.ts packages/db/src/job-timing.test.ts && bun run --cwd packages/db typecheck`

Expected: new tests pass. If the package-wide typecheck still fails only in the pre-existing `migrate.test.ts` `NonSharedBuffer` diagnostic, record that exact unrelated failure and run `bunx tsc -p packages/db/tsconfig.json --noEmit --pretty false` to confirm no diagnostic references the new module.

- [ ] **Step 7: Commit and push**

```bash
git add packages/db/src/job-resource-trends.ts packages/db/src/job-resource-trends.test.ts packages/db/src/index.ts
git commit -m "feat(db): aggregate job resource trends"
git push origin main
```

---

### Task 3: Expose the authenticated trends endpoint

**Files:**
- Modify: `apps/control-plane/src/http/dashboard-routes.ts:4-20,64-80`
- Modify: `apps/control-plane/src/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `listJobResourceTrends`, `JobResourceTrendResponse`, and `JobResourceTrendSort`.
- Produces: `GET /api/organizations/:organizationId/job-resource-trends`.

- [ ] **Step 1: Write failing HTTP boundary tests**

Add a fake database branch for the trend queries. Test:

```ts
test("returns validated job resource trends to organization members", async () => {
  const response = await appFor(member, trendDb()).request(
    "/api/organizations/org/job-resource-trends?from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&sort=memory&limit=50&pointLimit=100",
    { headers: sessionHeaders },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ summary: { jobCount: 1 }, jobs: [{ jobName: "build" }] });
});

test("rejects invalid trend bounds and foreign organizations", async () => {
  const invalid = await appFor().request("/api/organizations/org/job-resource-trends?from=nope", { headers: sessionHeaders });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).code).toBe("invalid_resource_trend_query");
  const foreign = await appFor(member, fakeDb([], false)).request("/api/organizations/foreign/job-resource-trends?from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z", { headers: sessionHeaders });
  expect(foreign.status).toBe(404);
});
```

Also assert `from < to`, maximum 90-day span, `limit <= 100`, `pointLimit <= 200`, valid sort values, and valid opaque cursors/keys.

- [ ] **Step 2: Run the route tests and verify RED**

Run: `bun test apps/control-plane/src/dashboard-api.test.ts`

Expected: FAIL with 404 for the missing route.

- [ ] **Step 3: Add query validation and route**

Create one strict schema near `timingQuerySchema`:

```ts
const jobResourceTrendQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  platform: z.string().max(100).optional(),
  vcpu: z.coerce.number().int().positive().optional(),
  concurrency: z.coerce.number().int().positive().optional(),
  search: z.string().max(200).default(""),
  sort: JobResourceTrendSort.default("latest"),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  jobKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  pointLimit: z.coerce.number().int().min(1).max(200).default(100),
}).strict().superRefine((value, ctx) => {
  const from = Date.parse(value.from), to = Date.parse(value.to);
  if (from >= to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
  if (to - from > 90 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "range must not exceed 90 days" });
});
```

Authorize with the existing `guard`, invoke `listJobResourceTrends`, parse with `JobResourceTrendResponse`, and return `invalid_resource_trend_query` for query or codec failures.

- [ ] **Step 4: Verify route behavior**

Run: `bun test apps/control-plane/src/dashboard-api.test.ts packages/db/src/job-resource-trends.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add apps/control-plane/src/http/dashboard-routes.ts apps/control-plane/src/dashboard-api.test.ts
git commit -m "feat(control-plane): expose job resource trends"
git push origin main
```

---

### Task 4: Add the web data client and presentation model

**Files:**
- Modify: `apps/web/src/api.ts:1-25,125-140`
- Create: `apps/web/src/routes/timing-model.ts`
- Create: `apps/web/src/routes/timing-model.test.ts`

**Interfaces:**
- Produces:

```ts
export type TimingRange = "24h" | "7d" | "30d" | "90d";
export type TimingFilters = { range: TimingRange; platform: string; vcpu: string; concurrency: string; search: string; sort: JobResourceTrendSort };
export function timingRangeBounds(range: TimingRange, now?: Date): { from: string; to: string };
export function formatDuration(ms: number): string;
export function formatBytes(bytes: number | null): string;
export function formatPercent(value: number | null, digits?: number): string;
export function selectionAfterJobsChange(current: string | null, jobs: readonly JobResourceTrendJob[]): string | null;
export function getJobResourceTrends(organizationId: string, params: JobResourceTrendRequest): Promise<JobResourceTrendResponse>;
```

- [ ] **Step 1: Write failing model and API URL tests**

Use a fixed `now` and assert exact ISO bounds. Cover `0 ms`, seconds, minutes, hours, byte unit boundaries, null formatting, and selection preservation/replacement.

```ts
test("derives exact supported range bounds", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  expect(timingRangeBounds("24h", now)).toEqual({ from: "2026-09-02T12:00:00.000Z", to: "2026-09-03T12:00:00.000Z" });
  expect(timingRangeBounds("7d", now).from).toBe("2026-08-27T12:00:00.000Z");
});

test("preserves selection until filters remove it", () => {
  const jobs = [{ jobKey: "first" }, { jobKey: "second" }] as JobResourceTrendJob[];
  expect(selectionAfterJobsChange("second", jobs)).toBe("second");
  expect(selectionAfterJobsChange("missing", jobs)).toBe("first");
  expect(selectionAfterJobsChange("missing", [])).toBeNull();
});
```

Extract the URL builder if needed so the test can assert all non-empty parameters and omission of empty filters without mocking `fetch`.

- [ ] **Step 2: Run model tests and verify RED**

Run: `bun test apps/web/src/routes/timing-model.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement request and presentation helpers**

Use `Intl.NumberFormat` and explicit IEC thresholds. Duration formatting must choose the smallest useful stable form: `<60s` as seconds, `<60m` as minutes/seconds, otherwise hours/minutes. Null resource values return `Unavailable`.

Add `getJobResourceTrends` to `api.ts`, validating with `JobResourceTrendResponse`:

```ts
export function getJobResourceTrends(organizationId: string, params: JobResourceTrendRequest) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  return request(`/api/organizations/${organizationId}/job-resource-trends?${query}`, JobResourceTrendResponse);
}
```

- [ ] **Step 4: Verify model tests and web typecheck**

Run: `bun test apps/web/src/routes/timing-model.test.ts && bun run --cwd apps/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add apps/web/src/api.ts apps/web/src/routes/timing-model.ts apps/web/src/routes/timing-model.test.ts
git commit -m "feat(web): add resource trend data model"
git push origin main
```

---

### Task 5: Build the job list, summary, and controls

**Files:**
- Create: `apps/web/src/components/TimingToolbar.tsx`
- Create: `apps/web/src/components/TimingSummary.tsx`
- Create: `apps/web/src/components/JobResourceList.tsx`
- Create: `apps/web/src/components/JobResourceHistory.test.tsx`

**Interfaces:**
- Consumes: `TimingFilters`, formatting helpers, `JobResourceTrendJob`, and response summary/filter facets.
- Produces controlled presentational components; none fetch data directly.

```ts
export type TimingToolbarProps = {
  filters: TimingFilters;
  facets: JobResourceTrendResponse["filters"];
  generatedAt: string | null;
  refreshing: boolean;
  onChange(next: TimingFilters): void;
  onRefresh(): void;
};

export type JobResourceListProps = {
  jobs: readonly JobResourceTrendJob[];
  selectedJobKey: string | null;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  onSelect(jobKey: string): void;
  onLoadMore(): void;
};
```

- [ ] **Step 1: Write failing render tests**

Render components with `renderToStaticMarkup`. Assert:

- Toolbar labels and 24h/7d/30d/90d controls.
- 7d is pressed for default filters.
- Reset is absent for defaults and present after another filter is set.
- Summary outputs readable duration and coverage.
- Two same-named jobs in different repositories render as separate options.
- Partial coverage has visible and screen-reader-readable warning text.
- Raw bytes and raw millisecond strings are absent.

```ts
const html = renderToStaticMarkup(<JobResourceList jobs={[repoOneBuild, repoTwoBuild]} selectedJobKey={repoTwoBuild.jobKey} hasNextPage={false} fetchingNextPage={false} onSelect={() => {}} onLoadMore={() => {}} />);
expect(html.match(/build/g)?.length).toBeGreaterThanOrEqual(2);
expect(html).toContain("acme/app");
expect(html).toContain("acme/service");
expect(html).toContain('aria-selected="true"');
```

- [ ] **Step 2: Run component tests and verify RED**

Run: `bun test apps/web/src/components/JobResourceHistory.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement controlled toolbar and summary**

Use semantic fieldsets for the time-range segmented control, associated labels for selects/search, a real button for refresh, and `aria-live="polite"` for updating status. Populate numeric selects from facets. Reset to:

```ts
export const defaultTimingFilters: TimingFilters = {
  range: "7d", platform: "", vcpu: "", concurrency: "", search: "", sort: "latest",
};
```

- [ ] **Step 4: Implement the selectable job list**

Use a labelled single-select listbox or a list of buttons with `aria-current`; choose one pattern and implement complete keyboard semantics rather than mixing patterns. Keep every row one large target. Show job name, repository/workflow, run count, latest completion, median duration, CPU peak, memory peak, and delta arrows with textual labels. `null` deltas show no arrow.

Add an `IntersectionObserver` sentinel that invokes `onLoadMore` once when visible and `hasNextPage && !fetchingNextPage`. Provide a non-JavaScript-observer fallback button with visually subdued styling; do not create a prominent page-level action.

- [ ] **Step 5: Verify component tests**

Run: `bun test apps/web/src/components/JobResourceHistory.test.tsx apps/web/src/routes/timing-model.test.ts && bun run --cwd apps/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add apps/web/src/components/TimingToolbar.tsx apps/web/src/components/TimingSummary.tsx apps/web/src/components/JobResourceList.tsx apps/web/src/components/JobResourceHistory.test.tsx
git commit -m "feat(web): add resource history controls"
git push origin main
```

---

### Task 6: Build aligned TanStack resource charts and accessible measurements

**Files:**
- Create: `apps/web/src/components/JobResourceCharts.tsx`
- Create: `apps/web/src/components/JobRunMeasurements.tsx`
- Create: `apps/web/src/components/JobResourceDetail.tsx`
- Modify: `apps/web/src/components/JobResourceHistory.test.tsx`

**Interfaces:**
- Consumes: ordered `readonly JobResourceTrendPoint[]`, selected run ID, and formatting helpers.
- Produces:

```ts
type ResourceChartProps = {
  points: readonly JobResourceTrendPoint[];
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
};
export function CpuTrendChart(props: ResourceChartProps): React.ReactNode;
export function MemoryTrendChart(props: ResourceChartProps & { requestedMemoryBytes: number | null }): React.ReactNode;
export function DurationTrendChart(props: ResourceChartProps): React.ReactNode;
```

- [ ] **Step 1: Extend failing render tests for charts and table**

Assert the detail renders all three labelled chart regions, formatted values, telemetry-quality text, outcome text, and links to `/runs/:runId`. Assert unavailable telemetry remains `Unavailable` and is not rendered as `0%` or `0 B`.

```ts
const html = renderToStaticMarkup(<JobResourceDetail organizationId="org-1" job={selectedJob} selectedRunId={null} onSelectRun={() => {}} />);
expect(html).toContain("CPU usage over completed runs");
expect(html).toContain("Peak memory over completed runs");
expect(html).toContain("Execution duration over completed runs");
expect(html).toContain("1.8 GiB");
expect(html).toContain('href="/runs/run-1"');
```

- [ ] **Step 2: Run component tests and verify RED**

Run: `bun test apps/web/src/components/JobResourceHistory.test.tsx`

Expected: FAIL because the detail and charts do not exist.

- [ ] **Step 3: Implement CPU, memory, and duration chart definitions**

Follow `JobActivityChart.tsx` and `OutcomeBars.tsx`. Transform points into flat chart rows with a shared string run-position key such as `${index + 1}` and retain the run ID in every row.

CPU uses `lineY` for average and peak series, memory uses `lineY` for peak and requested reference, and duration uses `barY`. Use point/band scales for ordered run positions and linear scales with grid lines for values. Configure metric colors explicitly from CSS-compatible values. Tooltips format dates and units; they do not expose raw storage values.

```ts
const definition = useMemo(() => defineChart({
  marks: [lineY(rows, { x: "position", y: "value", z: "series", color: "series", points: true })],
  x: { scale: () => scalePoint<string>().padding(0.4), axis: { label: "Completed runs", format: position => labels.get(position) ?? position } },
  y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "CPU", format: value => `${Number(value).toFixed(0)}%` } },
  color: { scale: () => scaleOrdinal<string, string>().domain(["Average", "Peak"]).range(["#4f83ff", "#8bc9dc"]) },
  tooltip: tooltip({ grouped: true }),
}), [rows, labels]);
```

Filter null metric rows before creating marks so gaps remain gaps. Keep failed/cancelled outcomes in rows and render their outcome in tooltip/table. Use public mark event callbacks if TanStack Charts 0.11 exposes them. If it does not, put durable selection in the accessible table and keep chart hover independent; do not reach into generated SVG/DOM.

- [ ] **Step 4: Implement measurements table and detail composition**

The table is the complete accessible equivalent. Columns: completed, outcome, execution duration, CPU average, CPU peak, memory peak, requested vCPU/memory, parallelism, and telemetry. Each row contains a TanStack Router `Link` to `/runs/$runId` with `{ runId }` params.

Show one partial-coverage warning beside detail metadata. If all resource values are unavailable, show CPU/memory explanations while preserving the duration chart and table.

- [ ] **Step 5: Verify chart and detail tests**

Run: `bun test apps/web/src/components/JobResourceHistory.test.tsx apps/web/src/components/JobActivityChart.test.tsx apps/web/src/components/OutcomeBars.test.tsx && bun run --cwd apps/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add apps/web/src/components/JobResourceCharts.tsx apps/web/src/components/JobRunMeasurements.tsx apps/web/src/components/JobResourceDetail.tsx apps/web/src/components/JobResourceHistory.test.tsx
git commit -m "feat(web): chart job resource history"
git push origin main
```

---

### Task 7: Compose the resource-history page and responsive states

**Files:**
- Modify: `apps/web/src/routes/TimingHistoryPage.tsx:1-34`
- Create: `apps/web/src/routes/TimingHistoryPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes all web interfaces from Tasks 4–6.
- Produces the complete `/runs/timing` experience.

- [ ] **Step 1: Write failing page-state tests**

Export a `jobResourceTrendQueryOptions` builder and test that it defaults to 7 days, includes all active filters, preserves prior data while refreshing, and changes `jobKey` when selection changes. Test a pure page-state helper for empty/no-match distinction so the behavior does not depend on mocking TanStack Query internals.

```ts
test("resource history defaults to a seven-day bounded request", () => {
  const options = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, null, new Date("2026-09-03T12:00:00.000Z"));
  expect(options.queryKey).toContain("job-resource-trends");
  expect(options.queryFn).toBeFunction();
  expect(options.placeholderData).toBeDefined();
});
```

- [ ] **Step 2: Run page tests and verify RED**

Run: `bun test apps/web/src/routes/TimingHistoryPage.test.tsx`

Expected: FAIL because the query options builder does not exist.

- [ ] **Step 3: Replace the old timing tables with the composed page**

Use `useInfiniteQuery` for job-summary pages and a selected job key in component state. The first page supplies summary/facets/selected points; later pages append only job summaries. Reset pagination when filters or sort change. Debounce search by 250 ms while keeping the field controlled and immediately responsive.

Preserve prior query data with TanStack Query placeholder data during refresh. Derive selection through `selectionAfterJobsChange`. The render order is:

1. Header and metrics disclosure.
2. Toolbar.
3. Summary strip.
4. Inline stale/error banner when applicable.
5. Job list and selected detail.

Use `QueryState` only for first-load failure/empty behavior; do not blank established content during background refresh.

- [ ] **Step 4: Add focused responsive styles**

Add one `.resource-history` namespace. Implement:

- Compact filter toolbar and segmented range control.
- Four-column summary strip collapsing to two and then one column.
- 35/65 desktop workspace with `minmax(280px, .55fr) minmax(0, 1fr)`.
- Selected list-row edge, warning treatment, metric columns, and contained list scrolling.
- Three chart panels with consistent heights and aligned spacing.
- Bounded horizontally scrollable measurements table.
- Tablet/mobile single-column order with no page-level overflow.
- Skeleton, updating, no-match, stale, and error states.
- Existing `prefers-reduced-motion` behavior.

Do not modify global Mars colors or unrelated pages.

- [ ] **Step 5: Run web tests and build**

Run: `bun test apps/web/src/routes/TimingHistoryPage.test.tsx apps/web/src/components/JobResourceHistory.test.tsx apps/web/src/routes/timing-model.test.ts && bun run --cwd apps/web typecheck && bun run --cwd apps/web build`

Expected: PASS with a successful production bundle.

- [ ] **Step 6: Verify the actual UI in Chromium**

Start the existing development stack with `bun run dev`. Open `http://localhost:5173/runs/timing` in an authenticated browser and verify:

- 1440×1000: two-column workspace, readable charts, selection updates, refresh, filters, tooltip values, and run links.
- 768×1024: toolbar wraps and detail remains readable.
- 390×844: list precedes charts, no page-level horizontal overflow, table scroll is contained.
- Keyboard: range controls, filters, job selection, table links, and focus visibility.
- Data states: use filters to produce no matches; inspect a job with unavailable or partial telemetry; simulate an API failure in DevTools and confirm stale data plus retry banner.
- Console: no React, Zod, chart, or accessibility-related errors.

Capture screenshots at desktop and mobile widths as verification artifacts; do not commit generated screenshots unless the repository already tracks UI evidence.

- [ ] **Step 7: Commit and push**

```bash
git add apps/web/src/routes/TimingHistoryPage.tsx apps/web/src/routes/TimingHistoryPage.test.tsx apps/web/src/styles.css
git commit -m "feat(web): redesign job resource history"
git push origin main
```

---

### Task 8: End-to-end contract verification and cleanup

**Files:**
- Modify only files implicated by failures caused by Tasks 1–7.

**Interfaces:**
- Verifies the complete endpoint-to-browser contract; produces no new public API.

- [ ] **Step 1: Run the focused cross-layer suite**

```bash
bun test packages/contracts/src/dashboard-api.test.ts packages/db/src/job-resource-trends.test.ts packages/db/src/job-timing.test.ts apps/control-plane/src/dashboard-api.test.ts apps/web/src/routes/timing-model.test.ts apps/web/src/components/JobResourceHistory.test.tsx apps/web/src/routes/TimingHistoryPage.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run affected package typechecks and web build**

```bash
bun run --cwd packages/contracts typecheck
bun run --cwd packages/db typecheck
bun run --cwd apps/control-plane typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
```

Expected: changed production files produce no diagnostics and the web build succeeds. The repository currently has unrelated package typecheck failures in existing tests and control-plane worker artifact code; compare any failures against the known baseline and fix only regressions introduced by this feature.

- [ ] **Step 3: Run final browser smoke verification**

Repeat the desktop and mobile `/runs/timing` checks against a production-equivalent local build. Confirm the network request uses bounded `limit` and `pointLimit`, the response validates, selecting a job updates charts/table, and opening a run navigates successfully.

- [ ] **Step 4: Remove obsolete timing-page code**

Delete imports and rendering paths for `getJobTimingAggregates` and the old timing comparison/measurement tables only when no remaining consumer uses them. Keep the backend aggregate endpoint if other clients or tests still reference it. Remove CSS selectors introduced solely for the replaced timing page; do not remove shared `.panel`, `.filter-bar`, or chart styles.

- [ ] **Step 5: Re-run focused verification after cleanup**

Run the exact commands from Steps 1 and 2 that cover any cleaned files. Expected: same passing results and no new diagnostics.

- [ ] **Step 6: Commit and push cleanup if needed**

If cleanup changed files:

```bash
git add <only-cleaned-files>
git commit -m "refactor(web): remove legacy timing view"
git push origin main
```

If cleanup made no changes, do not create an empty commit.
