import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSummary } from "@mars/contracts";
import { filterRuns, runDetailLink, RunHistory } from "./RunHistory.tsx";

const NOW = Date.parse("2026-08-13T16:00:00.000Z");
const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  id: "run-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryName: "mars",
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
  allocationState: "mars",
  ...overrides,
});

test("filters run history across Blacksmith metadata", () => {
  const runs = [run(), run({ id: "run-2", workflowName: "Release", branch: "feat/pink", conclusion: "failure" })];
  expect(filterRuns(runs, "PINK", "all", NOW).map((item) => item.id)).toEqual(["run-2"]);
  expect(filterRuns(runs, "tart vm", "all", NOW).map((item) => item.id)).toEqual(["run-1", "run-2"]);
});
test("filters runs by runner ownership", () => {
  const runs = [run({ id: "white", allocationState: "mars" }), run({ id: "external", allocationState: "external" })];
  expect(filterRuns(runs, "", "all", NOW, "all").map((item) => item.id)).toEqual(["white", "external"]);
  expect(filterRuns(runs, "", "all", NOW, "mars").map((item) => item.id)).toEqual(["white"]);
  expect(filterRuns(runs, "", "all", NOW, "external").map((item) => item.id)).toEqual(["external"]);
});

test("renders the runner filter with All selected by default", () => {
  const html = renderToStaticMarkup(<RunHistory runs={[run()]} allowDetails={false} nowMs={NOW} />);
  expect(html).toContain(">All</button>");
  expect(html).toContain(">Mars</button>");
  expect(html).toContain(">External</button>");
  expect(html).toContain('aria-pressed="true">All</button>');
  expect(html).toContain('aria-pressed="false">Mars</button>');
  expect(html).toContain('aria-pressed="false">External</button>');
});

test("uses locale-independent casing for metadata search", () => {
  const istanbul = run({ id: "istanbul", workflowName: "Istanbul release" });
  expect(filterRuns([istanbul], "istanbul", "all", NOW).map((item) => item.id)).toEqual(["istanbul"]);
});

test("filters the current API page by queued time with an exact boundary", () => {
  const edge = run({ id: "edge", queuedAt: "2026-08-13T15:00:00.000Z" });
  const old = run({ id: "old", queuedAt: "2026-08-13T14:59:59.999Z" });
  expect(filterRuns([edge, old], "", "1h", NOW).map((item) => item.id)).toEqual(["edge"]);
});

test("uses all as the default range and returns an empty result when nothing matches", () => {
  const old = run({ id: "old", queuedAt: "2020-01-01T00:00:00.000Z" });
  expect(filterRuns([old], "", "all", NOW)).toHaveLength(1);
  expect(filterRuns([old], "missing", "all", NOW)).toEqual([]);
});

test("retains organization context in run detail links", () => {
  expect(runDetailLink(run({ status: "completed", conclusion: "failure" }))).toEqual({
    to: "/runs/$runId",
    params: { runId: "run-1" },
    search: { organizationId: "org-1" },
  });
});

test("renders dense history rows and an in-panel empty state", () => {
  const html = renderToStaticMarkup(<RunHistory runs={[run()]} allowDetails={false} nowMs={NOW} />);
  expect(html).toContain("macOS runner smoke");
  expect(html).toContain("#11");
  expect(renderToStaticMarkup(<RunHistory runs={[]} allowDetails={false} nowMs={NOW} />)).toContain("No runs match these filters.");
});

test("does not mark externally routed jobs as awaiting Mars allocation", () => {
  const html = renderToStaticMarkup(<RunHistory runs={[run({
    status: "queued",
    conclusion: null,
    startedAt: null,
    completedAt: null,
    runtimeBoundary: null,
    allocationState: "external",
  })]} allowDetails={false} nowMs={NOW} />);
  expect(html).toContain("External runner");
  expect(html).not.toContain("Awaiting allocation");
});
