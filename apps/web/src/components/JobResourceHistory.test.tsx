import { expect, test } from "bun:test";
import type { JobResourceTrendJob, JobResourceTrendPoint, JobResourceTrendResponse } from "@mars/contracts";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { JobResourceList } from "./JobResourceList.tsx";
import { TimingSummary } from "./TimingSummary.tsx";
import { TimingToolbar } from "./TimingToolbar.tsx";
import { JobResourceDetail } from "./JobResourceDetail.tsx";
import { JobRunMeasurements } from "./JobRunMeasurements.tsx";
import { CpuTrendChart, DurationTrendChart, MemoryTrendChart, retainChartFocus } from "./JobResourceCharts.tsx";
import { defaultTimingFilters } from "../routes/timing-model.ts";

const facets: JobResourceTrendResponse["filters"] = {
  platforms: ["linux-x64", "windows-x64"],
  vcpus: [2, 4],
  concurrencies: [1, 3],
};

const summary: JobResourceTrendResponse["summary"] = {
  jobCount: 2,
  completedRunCount: 5,
  medianExecutionDurationMs: 65_432,
  telemetryCoveredRunCount: 4,
  telemetryCoveragePercent: 80,
};

const repoOneBuild: JobResourceTrendJob = {
  jobKey: "repo-one-ci-build",
  repositoryId: "11111111-1111-4111-8111-111111111111",
  repositoryName: "acme/app",
  workflowName: "CI",
  jobName: "build",
  platform: "windows-x64",
  runCount: 3,
  latestCompletedAt: "2026-09-03T12:00:00.000Z",
  latestRequestedVcpu: 4,
  latestRequestedMemoryBytes: 4_294_967_296,
  latestEffectiveConcurrency: 3,
  medianExecutionDurationMs: 65_432,
  cpuPeakPercent: 84.5,
  memoryPeakBytes: 2_147_483_648,
  telemetryCoveredRunCount: 1,
  telemetryCoveragePercent: 100 / 3,
  durationChangePercent: 12.5,
  cpuChangePercent: -4,
  memoryChangePercent: null,
};

const repoTwoBuild: JobResourceTrendJob = {
  ...repoOneBuild,
  jobKey: "repo-two-ci-build",
  repositoryId: "22222222-2222-4222-8222-222222222222",
  repositoryName: "acme/service",
  runCount: 1,
  latestCompletedAt: "2026-09-03T11:00:00.000Z",
  medianExecutionDurationMs: 58_000,
  cpuPeakPercent: null,
  memoryPeakBytes: null,
  telemetryCoveredRunCount: 0,
  telemetryCoveragePercent: 0,
  durationChangePercent: -8,
  cpuChangePercent: null,
};

const resourcePoints: readonly JobResourceTrendPoint[] = [
  {
    organizationId: "org-1",
    runId: "run-1",
    jobId: "job-1",
    completedAt: "2026-09-01T10:00:00.000Z",
    outcome: "failure",
    executionDurationMs: 65_432,
    cpuAveragePercent: 42.5,
    cpuPeakPercent: 84.5,
    memoryPeakBytes: 1_932_735_283,
    requestedVcpu: 4,
    requestedMemoryBytes: 2_147_483_648,
    effectiveConcurrency: 3,
    telemetryState: "partial",
    telemetrySampleCount: 5,
  },
  {
    organizationId: "org-1",
    runId: "run-2",
    jobId: "job-2",
    completedAt: "2026-09-02T10:00:00.000Z",
    outcome: "success",
    executionDurationMs: 58_000,
    cpuAveragePercent: null,
    cpuPeakPercent: null,
    memoryPeakBytes: null,
    requestedVcpu: 4,
    requestedMemoryBytes: 2_147_483_648,
    effectiveConcurrency: 3,
    telemetryState: "unavailable",
    telemetrySampleCount: 0,
  },
  {
    organizationId: "org-1",
    runId: "run-3",
    jobId: "job-3",
    completedAt: "2026-09-03T10:00:00.000Z",
    outcome: "cancelled",
    executionDurationMs: 10_000,
    cpuAveragePercent: 20,
    cpuPeakPercent: 30,
    memoryPeakBytes: 1_073_741_824,
    requestedVcpu: 4,
    requestedMemoryBytes: 4_294_967_296,
    effectiveConcurrency: 3,
    telemetryState: "available",
    telemetrySampleCount: 8,
  },
];

const selectedJob: NonNullable<JobResourceTrendResponse["selectedJob"]> = {
  summary: {
    ...repoOneBuild,
    runCount: 300,
    telemetryCoveredRunCount: 200,
    telemetryCoveragePercent: 200 / 3,
  },
  points: [...resourcePoints],
};

const noop = () => {};

function createTestRouter(content: ReactNode) {
  const rootRoute = createRootRoute({ component: () => content });
  const runRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "runs/$runId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([runRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function renderWithRouter(content: ReactNode): string {
  const router = createTestRouter(content);
  return renderToStaticMarkup(<RouterContextProvider router={router}>{content}</RouterContextProvider>);
}

function renderToolbar(filters = defaultTimingFilters) {
  return renderToStaticMarkup(
    <TimingToolbar
      filters={filters}
      facets={facets}
      generatedAt="2026-09-03T12:00:00.000Z"
      refreshing={false}
      onChange={noop}
      onRefresh={noop}
    />,
  );
}

test("renders labelled controlled timing filters with the seven-day default", () => {
  const html = renderToolbar();

  for (const label of ["Time range", "Platform", "vCPU", "Concurrency", "Search jobs", "Sort by"]) {
    expect(html).toContain(label);
  }
  for (const range of ["24h", "7d", "30d", "90d"]) expect(html).toContain(`>${range}</button>`);
  expect(html).toContain('aria-pressed="true">7d</button>');
  expect(html).toContain('aria-pressed="false">24h</button>');
  expect(html).toContain("Refresh");
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain(">Reset</button>");
});

test("shows reset only when controlled filters differ from their defaults", () => {
  const html = renderToolbar({ ...defaultTimingFilters, range: "30d", vcpu: "4" });

  expect(html).toContain('aria-pressed="true">30d</button>');
  expect(html).toContain('<option value="4" selected="">4</option>');
  expect(html).toContain(">Reset</button>");
});

test("renders summary duration and telemetry coverage in readable units", () => {
  const html = renderToStaticMarkup(<TimingSummary summary={summary} />);

  expect(html).toContain("2 jobs");
  expect(html).toContain("5 completed runs");
  expect(html).toContain("1m 5s");
  expect(html).toContain("80.0%");
  expect(html).toContain("4 of 5 runs");
  expect(html).not.toContain("65432 ms");
});

test("keeps same-named jobs in separate selectable options with repository and workflow identity", () => {
  const html = renderToStaticMarkup(
    <JobResourceList
      jobs={[repoOneBuild, repoTwoBuild]}
      selectedJobKey={repoTwoBuild.jobKey}
      hasNextPage={false}
      fetchingNextPage={false}
      paginationKey="test"
      onSelect={noop}
      onLoadMore={noop}
    />,
  );

  expect(html.match(/build/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain("acme/app");
  expect(html).toContain("acme/service");
  expect(html.match(/CI/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain('role="listbox"');
  expect(html).toContain('aria-selected="true"');
});

test("formats job metrics and exposes partial coverage and delta direction without raw storage values", () => {
  const html = renderToStaticMarkup(
    <JobResourceList
      jobs={[repoOneBuild]}
      selectedJobKey={repoOneBuild.jobKey}
      hasNextPage={false}
      fetchingNextPage={false}
      paginationKey="test"
      onSelect={noop}
      onLoadMore={noop}
    />,
  );

  expect(html).toContain("3 runs");
  expect(html).toContain("1m 5s");
  expect(html).toContain("84.5%");
  expect(html).toContain("2.0 GiB");
  expect(html).toContain("Partial telemetry coverage: 1 of 3 runs");
  expect(html).toContain("Duration change");
  expect(html).toContain("increased");
  expect(html).toContain("CPU peak change");
  expect(html).toContain("decreased");
  expect(html).not.toContain("Memory peak change");
  expect(html).not.toContain("2147483648 B");
  expect(html).not.toContain("65432 ms");
});

test("re-arms automatic pagination after each completed page and keeps the manual fallback", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalObserver = globalThis.IntersectionObserver;
  const window = new Window();
  const observerCallbacks: IntersectionObserverCallback[] = [];
  let observedElement: Element | undefined;

  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    constructor(callback: IntersectionObserverCallback) { observerCallbacks.push(callback); }
    disconnect() {}
    observe(target: Element) { observedElement = target; }
    takeRecords(): IntersectionObserverEntry[] { return []; }
    unobserve() {}
  }

  // @ts-expect-error happy-dom supplies the DOM surface React needs for this focused component test.
  globalThis.document = window.document;
  // @ts-expect-error happy-dom's Window is structurally compatible at runtime.
  globalThis.window = window;
  globalThis.IntersectionObserver = TestIntersectionObserver;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let loadCount = 0;

  const renderList = async (fetchingNextPage: boolean, jobs: readonly JobResourceTrendJob[] = [repoOneBuild]) => {
    await act(async () => {
      root.render(
        <JobResourceList
          jobs={jobs}
          selectedJobKey={repoOneBuild.jobKey}
          hasNextPage
          fetchingNextPage={fetchingNextPage}
          paginationKey="test"
          onSelect={noop}
          onLoadMore={() => { loadCount += 1; }}
        />,
      );
    });
  };

  try {
    await renderList(false);

    const fallback = container.querySelector<HTMLButtonElement>("button.load-more");
    expect(fallback?.textContent).toBe("Load more jobs");
    expect(observedElement).not.toBeUndefined();
    const entry = { isIntersecting: true, target: observedElement } as IntersectionObserverEntry;
    await act(async () => { observerCallbacks[0]?.([entry], {} as IntersectionObserver); });
    await act(async () => { observerCallbacks[0]?.([entry], {} as IntersectionObserver); });
    expect(loadCount).toBe(1);

    await renderList(true);
    await renderList(false);
    expect(observerCallbacks).toHaveLength(1);
    expect(loadCount).toBe(1);

    await renderList(false, [repoOneBuild, repoTwoBuild]);
    expect(observerCallbacks).toHaveLength(2);
    await act(async () => { observerCallbacks[1]?.([entry], {} as IntersectionObserver); });
    expect(loadCount).toBe(2);

    await act(async () => { fallback?.click(); });
    expect(loadCount).toBe(3);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.IntersectionObserver = originalObserver;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

test("gives focused listbox options explicit identity and supports keyboard and pointer selection", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const window = new Window();
  // @ts-expect-error happy-dom supplies the DOM surface React needs for this focused component test.
  globalThis.document = window.document;
  // @ts-expect-error happy-dom's Window is structurally compatible at runtime.
  globalThis.window = window;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const selectedKeys: string[] = [];

  try {
    await act(async () => {
      root.render(
        <JobResourceList
          jobs={[repoOneBuild, repoTwoBuild]}
          selectedJobKey={repoOneBuild.jobKey}
          hasNextPage={false}
          fetchingNextPage={false}
          paginationKey="test"
          onSelect={(jobKey) => { selectedKeys.push(jobKey); }}
          onLoadMore={noop}
        />,
      );
    });

    const options = Array.from(container.querySelectorAll<HTMLElement>("[role='option']"));
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1]);
    options[0]?.focus();
    options[0]?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
    expect(document.activeElement).toBe(options[1]);
    const focusedOption = document.activeElement as HTMLElement;
    const labelledBy = focusedOption.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
    const accessibleIdentity = labelledBy.map((id) => document.getElementById(id)?.textContent?.trim()).join(" ");
    expect(accessibleIdentity).toBe("build acme/service · CI");
    const describedBy = focusedOption.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
    const accessibleDescription = describedBy.map((id) => document.getElementById(id)?.textContent?.trim()).join(" ");
    expect(accessibleDescription).toContain("1 run");
    expect(accessibleDescription).toContain("Latest completion");
    expect(accessibleDescription).toContain("Median duration");
    expect(accessibleDescription).toContain("CPU peak");
    expect(accessibleDescription).toContain("Memory peak");
    expect(accessibleDescription).toContain("Partial telemetry coverage: 0 of 1 run");
    expect(selectedKeys.at(-1)).toBe(repoTwoBuild.jobKey);

    options[0]?.click();
    expect(document.activeElement).toBe(options[0]);
    expect(selectedKeys.at(-1)).toBe(repoOneBuild.jobKey);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

test("renders aligned resource charts and a complete accessible measurements table", async () => {
  const html = await renderWithRouter(
    <JobResourceDetail
      job={selectedJob}
      selectedRunId="run-1"
      onSelectRun={noop}
    />,
  );

  expect(html).toContain("CPU usage over completed runs");
  expect(html).toContain("Peak memory over completed runs");
  expect(html).toContain("Execution duration over completed runs");
  expect(html).toContain("<svg");
  for (const heading of [
    "Completed",
    "Outcome",
    "Execution duration",
    "CPU average",
    "CPU peak",
    "Memory peak",
    "Requested vCPU / memory",
    "Parallelism",
    "Telemetry",
  ]) {
    expect(html).toContain(heading);
  }
  expect(html).toContain("1m 5s");
  expect(html).toContain("42.5%");
  expect(html).toContain("84.5%");
  expect(html).toContain("1.8 GiB");
  expect(html).toContain("4 vCPU / 2.0 GiB");
  expect(html).toContain("3");
  expect(html).toContain("Failure");
  expect(html).toContain("Cancelled");
  expect(html).toContain("Partial · 5 samples");
  expect(html).toContain('href="/runs/run-1"');
  expect(html).toContain('href="/runs/run-1?organizationId=org-1"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-label="Select run completed Sep 1, 2026, 10:00 AM UTC"');
  expect(html).toContain("build");
  expect(html).toContain("acme/app · CI");
  expect(html).toContain("windows-x64");
  expect(html).toContain("300 completed runs");
  expect(html).toContain("3 sampled runs shown");
  expect(html).toContain("Latest request 4 vCPU / 4.0 GiB · Parallelism 3");
  expect(html).toContain("Partial telemetry coverage: 200 of 300 runs");
  expect(html).toContain("Sampled charts can miss short-lived peaks between collected observations.");
  expect(html.match(/Open run/g)?.length).toBeGreaterThanOrEqual(3);
  expect(html).not.toContain("1932735283 B");
  expect(html).not.toContain("65432 ms");
});

test("keeps unavailable resource telemetry unavailable without dropping duration history", async () => {
  const unavailablePoints = resourcePoints.map((point) => ({
    ...point,
    cpuAveragePercent: null,
    cpuPeakPercent: null,
    memoryPeakBytes: null,
    telemetryState: "unavailable" as const,
    telemetrySampleCount: 0,
  }));
  const html = await renderWithRouter(
    <JobResourceDetail
      job={{
        summary: { ...selectedJob.summary, telemetryCoveredRunCount: 0, telemetryCoveragePercent: 0 },
        points: unavailablePoints,
      }}
      selectedRunId={null}
      onSelectRun={noop}
    />,
  );

  expect(html).toContain("CPU telemetry is unavailable for these runs.");
  expect(html).toContain("Memory telemetry is unavailable for these runs.");
  expect(html).toContain("Execution duration over completed runs");
  expect(html).toContain("1m 5s");
  expect(html).toContain("Unavailable");
  expect(html).not.toContain(">0%</");
  expect(html).not.toContain(">0 B<");
});

test("leaves visible gaps where a completed run has null resource measurements", () => {
  const cpuDocument = new Window().document;
  cpuDocument.body.innerHTML = renderToStaticMarkup(
    <CpuTrendChart points={resourcePoints} selectedRunId={null} onSelectRun={noop} />,
  );
  const connectedCpuPaths = Array.from(cpuDocument.querySelectorAll(".ts-chart__line path"))
    .filter((path) => path.getAttribute("d")?.includes("L"));
  expect(connectedCpuPaths).toHaveLength(0);
  expect(cpuDocument.querySelectorAll("[data-ts-key^='x-tick-rule']")).toHaveLength(3);

  const memoryDocument = new Window().document;
  memoryDocument.body.innerHTML = renderToStaticMarkup(
    <MemoryTrendChart
      points={resourcePoints}
      selectedRunId={null}
      onSelectRun={noop}
    />,
  );
  const connectedMemoryPaths = Array.from(memoryDocument.querySelectorAll(".ts-chart__line path"))
    .filter((path) => path.getAttribute("d")?.includes("L"));
  expect(connectedMemoryPaths).toHaveLength(1);
  expect(memoryDocument.body.innerHTML).toContain("requested 4.0 GiB");
});

test("distinguishes failed, cancelled, and partial telemetry marks in every chart", () => {
  const chartDocuments = [
    ["cpu", <CpuTrendChart points={resourcePoints} selectedRunId={null} onSelectRun={noop} />],
    ["memory", <MemoryTrendChart points={resourcePoints} selectedRunId={null} onSelectRun={noop} />],
    ["duration", <DurationTrendChart points={resourcePoints} selectedRunId={null} onSelectRun={noop} />],
  ] as const;

  for (const [metric, chart] of chartDocuments) {
    const document = new Window().document;
    document.body.innerHTML = renderToStaticMarkup(chart);
    const hollowDegraded = document.querySelector(
      `[data-ts-key="${metric}-partial-outcome-markers"] circle`,
    );
    const degraded = document.querySelector(
      `[data-ts-key="${metric}-outcome-markers"] circle`,
    );
    expect(hollowDegraded?.getAttribute("fill")).toBe("#211917");
    expect(hollowDegraded?.getAttribute("stroke")).toBe("#e76f9b");
    expect(degraded?.getAttribute("fill")).toBe("#e76f9b");
    expect(document.body.textContent).toContain("Failed or cancelled run");
    expect(document.body.textContent).toContain("Partial telemetry (hollow mark)");
    expect(document.querySelector(`[data-ts-key="${metric}-unavailable-markers"] circle`)).toBeNull();
    if (metric === "duration") {
      expect(document.querySelectorAll('[data-ts-key="duration-bars"] rect')[1]?.getAttribute("fill")).toBe("#d6a15f");
    }
  }
});

test("keeps failed outcomes distinct when resource telemetry is unavailable", () => {
  const failedWithoutTelemetry = resourcePoints.map((point) => (
    point.runId === "run-2" ? { ...point, outcome: "failure" as const } : point
  ));
  for (const [metric, chart] of [
    ["memory", <MemoryTrendChart points={failedWithoutTelemetry} selectedRunId={null} onSelectRun={noop} />],
    ["duration", <DurationTrendChart points={failedWithoutTelemetry} selectedRunId={null} onSelectRun={noop} />],
  ] as const) {
    const document = new Window().document;
    document.body.innerHTML = renderToStaticMarkup(chart);
    expect(document.querySelector(`[data-ts-key="${metric}-outcome-markers"] circle[data-ts-key*="run-2"]`)).not.toBeNull();
  }
});

test("keeps the last focused run bound to its adjacent Open run action", () => {
  expect(retainChartFocus(resourcePoints[0]!, null)).toBe(resourcePoints[0]);
  expect(retainChartFocus(resourcePoints[0]!, resourcePoints[2]!)).toBe(resourcePoints[2]);
});

test("aligns line-point and bar centers for one, two, three, and many runs", () => {
  const alignmentPoints: readonly JobResourceTrendPoint[] = Array.from({ length: 5 }, (_, index) => ({
    ...resourcePoints[index % resourcePoints.length]!,
    runId: `alignment-run-${index + 1}`,
    jobId: `alignment-job-${index + 1}`,

    completedAt: `2026-09-0${index + 1}T10:00:00.000Z`,
    cpuAveragePercent: 20 + index,
    cpuPeakPercent: 40 + index,
    memoryPeakBytes: 1_073_741_824 + index * 134_217_728,
    outcome: "success",
    telemetryState: "available",
  }));

  type AttributeElement = { getAttribute(name: string): string | null };
  function normalizedCenters(axis: AttributeElement | null, elements: readonly AttributeElement[], center: (element: AttributeElement) => number): number[] {
    const start = Number(axis?.getAttribute("x1"));
    const width = Number(axis?.getAttribute("x2")) - start;
    return elements.map((element) => (center(element) - start) / width);
  }

  for (const count of [1, 2, 3, 5]) {
    const points = alignmentPoints.slice(0, count);
    const cpuDocument = new Window().document;
    cpuDocument.body.innerHTML = renderToStaticMarkup(
      <CpuTrendChart points={points} selectedRunId={null} onSelectRun={noop} />,
    );
    const memoryDocument = new Window().document;
    memoryDocument.body.innerHTML = renderToStaticMarkup(
      <MemoryTrendChart points={points} selectedRunId={null} onSelectRun={noop} />,
    );
    const durationDocument = new Window().document;
    durationDocument.body.innerHTML = renderToStaticMarkup(
      <DurationTrendChart points={points} selectedRunId={null} onSelectRun={noop} />,
    );

    const lineCenter = (element: AttributeElement) => Number(element.getAttribute("cx"));
    const barCenter = (element: AttributeElement) => Number(element.getAttribute("x")) + Number(element.getAttribute("width")) / 2;
    const cpuCenters = normalizedCenters(cpuDocument.querySelector('[data-ts-key="x-axis"]'), Array.from(cpuDocument.querySelectorAll('[data-ts-key="cpu-average-markers"] > circle')), lineCenter);
    const memoryCenters = normalizedCenters(memoryDocument.querySelector('[data-ts-key="x-axis"]'), Array.from(memoryDocument.querySelectorAll('[data-ts-key="memory-peak-markers"] > circle')), lineCenter);
    const durationCenters = normalizedCenters(durationDocument.querySelector('[data-ts-key="x-axis"]'), Array.from(durationDocument.querySelectorAll(".ts-chart__bar > rect")), barCenter);

    expect(cpuCenters).toHaveLength(count);
    expect(memoryCenters).toHaveLength(count);
    expect(durationCenters).toHaveLength(count);
    for (let index = 0; index < count; index += 1) {
      expect(cpuCenters[index]).toBeCloseTo(durationCenters[index]!, 4);
      expect(memoryCenters[index]).toBeCloseTo(durationCenters[index]!, 4);
    }
  }
});

test("keeps durable run selection in the accessible measurements table", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const window = new Window();
  // @ts-expect-error happy-dom supplies the DOM surface React needs for this focused component test.
  globalThis.document = window.document;
  // @ts-expect-error happy-dom's Window is structurally compatible at runtime.
  globalThis.window = window;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const selections: string[] = [];

  try {
    const measurements = (
      <JobRunMeasurements
        points={resourcePoints}
        selectedRunId="run-1"
        onSelectRun={(runId) => { selections.push(runId); }}
      />
    );
    const router = createTestRouter(measurements);
    await act(async () => {
      root.render(<RouterContextProvider router={router}>{measurements}</RouterContextProvider>);
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("tbody button"));
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    await act(async () => { buttons[2]?.click(); });
    expect(selections).toEqual(["run-3"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
