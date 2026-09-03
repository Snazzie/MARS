import { expect, test } from "bun:test";
import type { JobResourceTrendJob, JobResourceTrendResponse } from "@mars/contracts";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { JobResourceList } from "./JobResourceList.tsx";
import { TimingSummary } from "./TimingSummary.tsx";
import { TimingToolbar } from "./TimingToolbar.tsx";
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

const noop = () => {};

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

test("offers accessible manual pagination while the observer requests at most one automatic page", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalObserver = globalThis.IntersectionObserver;
  const window = new Window();
  let observerCallback: IntersectionObserverCallback | undefined;
  let observedElement: Element | undefined;

  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
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

  try {
    await act(async () => {
      root.render(
        <JobResourceList
          jobs={[repoOneBuild]}
          selectedJobKey={repoOneBuild.jobKey}
          hasNextPage
          fetchingNextPage={false}
          onSelect={noop}
          onLoadMore={() => { loadCount += 1; }}
        />,
      );
    });

    const fallback = container.querySelector<HTMLButtonElement>("button.load-more");
    expect(fallback?.textContent).toBe("Load more jobs");
    expect(observedElement).not.toBeUndefined();
    const entry = { isIntersecting: true, target: observedElement } as IntersectionObserverEntry;
    await act(async () => { observerCallback?.([entry], {} as IntersectionObserver); });
    await act(async () => { observerCallback?.([entry], {} as IntersectionObserver); });
    expect(loadCount).toBe(1);

    await act(async () => { fallback?.click(); });
    expect(loadCount).toBe(2);
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
