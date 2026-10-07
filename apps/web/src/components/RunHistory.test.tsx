import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSummary } from "@mars/contracts";
import { runDetailLink, RunHistory } from "./RunHistory.tsx";

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  id: "run-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryName: "mars",
  runNumber: 11,
  runAttempt: 1,
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

test("retains organization context in run detail links", () => {
  expect(runDetailLink(run({ status: "completed", conclusion: "failure" }))).toEqual({
    to: "/runs/$runId",
    params: { runId: "run-1" },
    search: { organizationId: "org-1" },
  });
});


test("does not mark externally routed jobs as awaiting Mars allocation", () => {
  const html = renderToStaticMarkup(<RunHistory runs={[run({
    status: "queued",
    conclusion: null,
    startedAt: null,
    completedAt: null,
    runtimeBoundary: null,
    allocationState: "external",
  })]} filters={{ search: "", range: "all", runner: "all" }} onFiltersChange={() => {}} allowDetails={false} />);
  expect(html).toContain("External runner");
  expect(html).not.toContain("Awaiting allocation");
});
