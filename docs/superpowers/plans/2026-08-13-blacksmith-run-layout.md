# Blacksmith-Inspired Run Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompose Whitesmith's run history and run detail pages into the approved Blacksmith-inspired, information-dense layout using only real data already available through the current run contracts.

**Architecture:** Keep route fetching and the existing application shell unchanged. Replace the table-oriented run presentation with a focused `RunHistory` component, extract the fetched detail body into a stateful `RunDetailView`, and extend `LogViewer` with controlled disclosures and loaded-log search. Pure filtering and formatting helpers carry deterministic tests; browser verification proves the final responsive composition.

**Tech Stack:** React 19, TypeScript, TanStack Router, TanStack Query, Bun test, Happy DOM, existing CSS design system.

## Global Constraints

- Keep the Whitesmith wordmark, sidebar navigation, workspace selector, and routing behavior unchanged.
- Reuse `RunSummary`, `RunDetail`, and existing APIs; do not change backend routes, database schema, contracts, or ingestion.
- Render only real Logs and Metrics tabs; do not render Network or Tests placeholders.
- Time controls filter only the current API response. Default to all returned runs.
- Preserve lifecycle telemetry, requested/observed resources, timeline, action graph, and unattributed logs.
- Do not add chart, icon, or UI dependencies.
- Status must use text and an icon in addition to color.
- Preserve loading, error, empty, pending-log, unavailable-log, and no-log distinctions.
- Respect reduced-motion preferences and keep all controls keyboard operable.

---

### Task 1: Data-Backed Run History Surface

**Files:**
- Rename: `apps/web/src/components/RunTable.tsx` → `apps/web/src/components/RunHistory.tsx`
- Rename: `apps/web/src/components/RunTable.test.tsx` → `apps/web/src/components/RunHistory.test.tsx`
- Modify: `apps/web/src/routes/RunsPage.tsx`
- Modify: `apps/web/src/routes/RunsPage.test.tsx`

**Interfaces:**
- Consumes: `readonly RunSummary[]`, TanStack `Link`, and `formatDuration(ms: number | null): string` from `RunTelemetry.tsx`.
- Produces: `RunHistoryRange`, `filterRuns(runs, search, range, nowMs)`, `runDetailLink(run)`, and `<RunHistory runs={runs} allowDetails? nowMs? />`.

- [ ] **Step 1: Resolve the current symbol and file references before renaming**

Use LSP references for `RunTable` and `runDetailLink`, then use LSP `rename_file` for `RunTable.tsx`. Update every returned import and test in the same cutover. There must be no compatibility export named `RunTable` after this task.

- [ ] **Step 2: Write deterministic history filtering tests**

Replace the old table-column assertions with behavior tests built from one fixture factory. Cover case-insensitive metadata search, exact time boundaries, the default `all` range, and an empty result.

```tsx
import { expect, test } from "bun:test";
import type { RunSummary } from "@whitesmith/contracts";
import { filterRuns, runDetailLink } from "./RunHistory.tsx";

const NOW = Date.parse("2026-08-13T16:00:00.000Z");
const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  id: "run-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryName: "whitesmith",
  runNumber: 11,
  workflowName: "macOS runner smoke",
  event: "workflow_dispatch",
  branch: "main",
  commitSha: "abcdef1234567890abcdef1234567890abcdef12",
  actorLogin: "Snazzie",
  status: "completed",
  conclusion: "success",
  queuedAt: "2026-08-13T15:30:00.000Z",
  startedAt: "2026-08-13T15:30:05.000Z",
  completedAt: "2026-08-13T15:31:35.000Z",
  durationMs: 90_000,
  runtimeBoundary: "Tart VM",
  ...overrides,
});

test("filters run history across Blacksmith metadata", () => {
  const runs = [run(), run({ id: "run-2", workflowName: "Release", branch: "feat/pink", conclusion: "failure" })];
  expect(filterRuns(runs, "PINK", "all", NOW).map((item) => item.id)).toEqual(["run-2"]);
  expect(filterRuns(runs, "tart vm", "all", NOW).map((item) => item.id)).toEqual(["run-1", "run-2"]);
});

test("filters the current API page by queued time", () => {
  const edge = run({ id: "edge", queuedAt: "2026-08-13T15:00:00.000Z" });
  const old = run({ id: "old", queuedAt: "2026-08-13T14:59:59.999Z" });
  expect(filterRuns([edge, old], "", "1h", NOW).map((item) => item.id)).toEqual(["edge"]);
});
```

Retain the existing `runDetailLink` organization-context assertion.

- [ ] **Step 3: Run the history tests and confirm the red state**

Run:

```bash
bun test apps/web/src/components/RunHistory.test.tsx apps/web/src/routes/RunsPage.test.tsx
```

Expected: failure because `RunHistory.tsx`, `RunHistoryRange`, and `filterRuns` do not yet exist under the final names.

- [ ] **Step 4: Implement the pure filter and status model**

Use a closed range union and an explicit duration map. Include `all` so the default does not misrepresent the current 50-run API page.

```tsx
export type RunHistoryRange = "all" | "1h" | "2h" | "4h" | "12h" | "1d" | "2d";
const RANGE_MS: Record<Exclude<RunHistoryRange, "all">, number> = {
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "2d": 172_800_000,
};

export function filterRuns(runs: readonly RunSummary[], search: string, range: RunHistoryRange, nowMs: number): RunSummary[] {
  const query = search.trim().toLocaleLowerCase();
  const cutoff = range === "all" ? Number.NEGATIVE_INFINITY : nowMs - RANGE_MS[range];
  return runs.filter((run) => {
    const inRange = Date.parse(run.queuedAt) >= cutoff;
    const result = run.conclusion ?? run.status.replace("_", " ");
    const searchable = [run.workflowName, run.repositoryName, run.branch, run.actorLogin, run.commitSha, result, run.runtimeBoundary ?? ""].join(" ").toLocaleLowerCase();
    return inRange && (!query || searchable.includes(query));
  });
}
```

Add one shared status descriptor that returns label plus semantic class. Use small inline SVG marks with `aria-hidden="true"`; the adjacent visible label carries the status text.

- [ ] **Step 5: Implement the chart and dense run rows**

`RunHistory` owns `search` and `range` state and computes `visibleRuns` with `useMemo`. Structure the surface as:

```tsx
<section className="run-history" aria-labelledby="run-history-title">
  <div className="run-history-toolbar">...</div>
  <div className="run-duration-chart" role="img" aria-label={chartDescription}>...</div>
  <div className="run-history-list">...</div>
</section>
```

Use semantic buttons for `All`, `1h`, `2h`, `4h`, `12h`, `1d`, and `2d`, with `aria-pressed` on the selected range. Scale every bar against the maximum nonzero visible duration; queued runs retain a minimum visible marker. Rows must include:

- result icon and visible result label;
- workflow name and `#runNumber`;
- actor, runner boundary, and queued timestamp;
- repository and branch;
- seven-character commit SHA with the full SHA in accessible text/title;
- formatted duration and a proportional duration rail.

When `allowDetails` is true, make one covering `Link` with `runDetailLink(run)`. When false, render the same content without a link for server-rendered tests. Render an in-panel `No runs match these filters.` state when `visibleRuns` is empty.

- [ ] **Step 6: Replace the route hero with the compact heading**

Keep `runsQueryOptions` and its two-second polling unchanged. Render:

```tsx
<header className="runs-heading">
  <div>
    <p className="eyebrow">Runs</p>
    <h1 id="run-history-title">Job Run History</h1>
  </div>
</header>
```

Pass successful nonempty data to `<RunHistory runs={query.data.items} />`. Preserve `QueryState` loading/error/empty behavior.

- [ ] **Step 7: Run history tests and commit**

Run:

```bash
bun test apps/web/src/components/RunHistory.test.tsx apps/web/src/routes/RunsPage.test.tsx
```

Expected: all history tests pass.

Commit:

```bash
git add apps/web/src/components/RunHistory.tsx apps/web/src/components/RunHistory.test.tsx apps/web/src/routes/RunsPage.tsx apps/web/src/routes/RunsPage.test.tsx
git commit -m "feat(web): add Blacksmith run history"
```

---

### Task 2: Real Logs and Metrics Detail Tabs

**Files:**
- Create: `apps/web/src/components/RunDetailView.tsx`
- Create: `apps/web/src/components/RunDetailView.test.tsx`
- Modify: `apps/web/src/routes/RunDetailPage.tsx`

**Interfaces:**
- Consumes: `RunDetail`, `RunJob`, `RunTelemetry`, `RunTimeline`, `ActionGraph`, and `LogViewer`.
- Produces: `runDetailFacts(data): { started: string; repository: string; runner: string; duration: string }` and `<RunDetailView data={data} organizationId={organizationId} />`.

- [ ] **Step 1: Write detail fact and tab tests**

Create a complete `RunDetail` fixture with one completed job and one step. Test real metadata mapping and explicit missing labels:

```tsx
expect(runDetailFacts(detail).runner).toBe("whitesmith-lease-1");
expect(runDetailFacts({ ...detail, startedAt: null, jobs: [{ ...detail.jobs[0], runnerName: null }] })).toMatchObject({
  started: "Not started",
  runner: "Awaiting runner",
});
```

Render `RunDetailView` inside a `QueryClientProvider` and assert:

- the `tablist` contains Logs and Metrics;
- Network and Tests are absent;
- Logs is selected by default;
- repository, runtime boundary, branch, actor, and commit remain visible;
- status includes both icon markup and visible text.

Add a Happy DOM interaction test that clicks Metrics and observes the Metrics panel while the Logs panel is not rendered.

- [ ] **Step 2: Run the detail tests and confirm the red state**

Run:

```bash
bun test apps/web/src/components/RunDetailView.test.tsx
```

Expected: failure because `RunDetailView` and `runDetailFacts` do not exist.

- [ ] **Step 3: Extract the detail body from the route**

Keep route params, search organization resolution, query key, query function, and `QueryState` in `RunDetailPage.tsx`. Replace the existing `RunDetailContent` with:

```tsx
{query.data && <RunDetailView data={query.data} organizationId={detailOrganizationId} />}
```

Move `ResourceTable` and all fetched-detail composition into `RunDetailView.tsx`. Do not change the API request.

- [ ] **Step 4: Implement compact detail facts and header**

Use `formatDuration` and `lifecycleMetrics` from `RunTelemetry.tsx`. `runDetailFacts` selects the first non-null job runner name, then falls back to `Awaiting runner`. Format started time using the existing locale date/time style. Use `In progress` when a duration cannot yet be terminally calculated.

The view header contains:

- workflow breadcrumb;
- icon plus status label;
- run number and workflow title;
- repository, runtime boundary, branch, actor, and short commit;
- four summary facts: Started, Repository, Runner, Duration.

All missing-data labels must be explicit and contract-backed.

- [ ] **Step 5: Implement two semantic tab panels**

Use local state `"logs" | "metrics"`. Tabs have stable IDs, `role="tab"`, `aria-selected`, `aria-controls`, and visible focus. Panels have `role="tabpanel"` and `aria-labelledby`.

Logs panel:

```tsx
{data.jobs.map((job) => (
  <section className="run-job-logs" key={job.id}>
    <header>...job name, runner, requested labels, status...</header>
    <LogViewer organizationId={organizationId} runId={data.id} jobId={job.id} logsState={job.logsState} steps={job.steps} />
  </section>
))}
```

Metrics panel retains:

- `<RunTelemetry ... />`;
- `<RunTimeline jobs={data.jobs} durations={stageDurations} />`;
- `<ActionGraph graph={data.actionGraph} />`;
- one compact resource card per job with requested and observed values.

Do not render `LogViewer` while Metrics is selected; this avoids background log requests from a hidden panel.

- [ ] **Step 6: Run detail tests and commit**

Run:

```bash
bun test apps/web/src/components/RunDetailView.test.tsx apps/web/src/components/LogViewer.test.tsx
```

Expected: all detail and unchanged log tests pass.

Commit:

```bash
git add apps/web/src/components/RunDetailView.tsx apps/web/src/components/RunDetailView.test.tsx apps/web/src/routes/RunDetailPage.tsx
git commit -m "feat(web): add run logs and metrics tabs"
```

---

### Task 3: Searchable, Controllable Step Logs

**Files:**
- Modify: `apps/web/src/components/LogViewer.tsx`
- Modify: `apps/web/src/components/LogViewer.test.tsx`

**Interfaces:**
- Consumes: existing `getLogs`, `getStepLogs`, query keys, and `RunStep`.
- Produces: `countLogLines(text): number`, `stepMatchesSearch(step, loadedText, search): boolean`, and the existing `LogViewer` props with richer controls.

- [ ] **Step 1: Write failing pure behavior tests**

Add exact tests for line count and loaded-text matching:

```tsx
expect(countLogLines("one\ntwo\n")).toBe(2);
expect(countLogLines("")).toBe(0);
expect(stepMatchesSearch(step({ name: "Install dependencies" }), "bun install", "DEPENDENCIES")).toBe(true);
expect(stepMatchesSearch(step({ name: "Build" }), "bun test\npass", "PASS")).toBe(true);
expect(stepMatchesSearch(step({ name: "Build" }), "bun test", "network")).toBe(false);
```

- [ ] **Step 2: Write a Happy DOM toolbar interaction test**

Seed a `QueryClient` with the job-log query and both step-log query keys. Render two steps. Verify:

1. both steps start closed;
2. `Expand all` opens both visible disclosures;
3. typing a step-name query leaves only the matching step visible;
4. `Collapse all` closes the visible disclosure;
5. the loaded step displays its computed line count and duration.

Use React 19 `act`, `createRoot`, real input/click events, and cleanup the root/container after the assertion. Do not inspect source text or internal component state.

- [ ] **Step 3: Run the log viewer test and confirm the red state**

Run:

```bash
bun test apps/web/src/components/LogViewer.test.tsx
```

Expected: failure because the helpers and controls do not exist.

- [ ] **Step 4: Make step disclosures parent-controlled**

Move expanded IDs into `LogViewer`:

```tsx
const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
const setStepExpanded = (stepId: string, expanded: boolean) => {
  setExpandedStepIds((current) => {
    const next = new Set(current);
    expanded ? next.add(stepId) : next.delete(stepId);
    return next;
  });
};
```

Pass `open`, `onOpenChange`, and `onLoadedTextChange` into `StepLogRow`. The step query remains enabled only when `open` is true. Use a guarded effect to report ordered loaded text to the parent only when it changes.

- [ ] **Step 5: Add search and expand/collapse controls**

`LogViewer` owns:

```tsx
const [search, setSearch] = useState("");
const [loadedTextByStep, setLoadedTextByStep] = useState<Record<string, string>>({});
```

Filter steps through `stepMatchesSearch(step, loadedTextByStep[step.id] ?? "", search)`. Search only loaded output; it must not eagerly fetch every collapsed step. Label the input `Search job steps and loaded logs` so the boundary is honest.

Add `Expand all` and `Collapse all` buttons. They modify only the currently visible step IDs. If there are no visible steps, render `No steps match this search.` while retaining the unattributed logs section.

Each summary displays:

- disclosure chevron;
- status icon plus text;
- step name;
- loaded line count, or `— lines` before output is available;
- formatted duration.

Keep pending, unavailable, empty, retry, pagination, and unattributed log messages unchanged.

- [ ] **Step 6: Run log tests and commit**

Run:

```bash
bun test apps/web/src/components/LogViewer.test.tsx apps/web/src/components/RunDetailView.test.tsx
```

Expected: all log and detail tests pass.

Commit:

```bash
git add apps/web/src/components/LogViewer.tsx apps/web/src/components/LogViewer.test.tsx
git commit -m "feat(web): add searchable step logs"
```

---

### Task 4: Blacksmith Visual System and Responsive Proof

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify only if browser verification exposes a real semantic/layout defect: files changed in Tasks 1–3 and their focused tests.

**Interfaces:**
- Consumes: class names introduced by `RunHistory`, `RunDetailView`, and `LogViewer`.
- Produces: desktop, tablet, and mobile layouts with no horizontal page overflow.

- [ ] **Step 1: Load the UI implementation guidance**

Read the `impeccable` skill before editing the stylesheet. Preserve the approved reference direction rather than introducing a separate aesthetic.

- [ ] **Step 2: Implement run-specific tokens and flat surfaces**

Add narrowly scoped run-workspace variables/classes rather than globally restyling Workers, Pools, Repositories, Settings, or Onboarding. Use:

- graphite background around `#161819`;
- panel around `#1c1e20`;
- hairline border around `#34373a`;
- primary text around `#ededed`;
- muted text around `#9a9da1`;
- blue around `#4f83ff` for success/running;
- pink around `#ff4f83` for failure;
- restrained compact radii of `6px`–`8px`.

Remove serif hero styling only within `.runs-heading` and `.run-detail-header`. The global shell and other routes retain their current theme.

- [ ] **Step 3: Style the run history composition**

Desktop requirements:

- compact header and top-aligned range controls;
- bordered toolbar integrated with the history panel;
- duration chart with baseline/grid lines and bars aligned to the list width;
- rows separated by hairlines with status/name on the left, repository/branch toward the right, and duration rail at the edge;
- entire linked row has hover and visible focus states without motion dependence.

At widths below 900px, stack chart controls and wrap row metadata. Below 640px, hide only redundant labels, not workflow/status/duration, and stack secondary metadata beneath the primary row.

- [ ] **Step 4: Style the run detail and log composition**

Desktop requirements:

- title and summary facts share the top row;
- tab bar is compact and visually connected to its panel;
- step summary aligns chevron, status, line count, title, and duration;
- expanded output uses a flat monospace surface with line wrapping disabled and local horizontal scrolling;
- Metrics cards use the same flat panel/border system.

At narrow widths, summary facts become a two-column grid, then one column. Tabs remain horizontally reachable. The page itself must not overflow horizontally.

- [ ] **Step 5: Run focused verification**

Run:

```bash
bun test \
  apps/web/src/components/RunHistory.test.tsx \
  apps/web/src/routes/RunsPage.test.tsx \
  apps/web/src/components/RunDetailView.test.tsx \
  apps/web/src/components/LogViewer.test.tsx
bun run --filter @whitesmith/web typecheck
```

Expected: all focused tests pass and TypeScript reports zero diagnostics.

- [ ] **Step 6: Run React Doctor**

Invoke the `react-doctor` skill and run its prescribed check over the changed React files. Fix only findings caused by this implementation, then rerun the focused tests and web typecheck if code changes.

- [ ] **Step 7: Smoke test the real UI in a browser**

Start the existing Whitesmith web/control-plane development path. Open `/runs` with real data and one real `/runs/:runId` detail page.

Desktop checks at approximately 1440×1000:

- filter text updates chart and rows together;
- every range button changes the visible set and selected state;
- a row navigates to the correct run with organization context;
- Logs is selected by default;
- expanding a step performs one lazy request and displays output/line count;
- search, expand all, and collapse all work;
- Metrics reveals lifecycle, resources, timeline, and graph;
- Network and Tests are absent.

Mobile checks at approximately 390×844:

- sidebar/mobile shell remains usable;
- no page-level horizontal overflow;
- workflow/status/duration remain visible in each row;
- detail facts stack without clipping;
- log output scrolls locally.

Inspect console and non-static network requests. Expected: no new console error, unhandled rejection, repeated failing request, or secret-bearing output.

- [ ] **Step 8: Commit the visual implementation**

```bash
git add apps/web/src/styles.css apps/web/src/components apps/web/src/routes
git commit -m "style(web): match Blacksmith run layouts"
```

The final commit must include only fixes actually required by the browser smoke; do not sweep unrelated existing changes.
