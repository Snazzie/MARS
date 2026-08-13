import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSummary } from "@whitesmith/contracts";
import { RunTable, runDetailLink } from "./RunTable.tsx";

const run: RunSummary = {
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
  queuedAt: "2026-08-13T14:00:00.000Z",
  startedAt: "2026-08-13T14:00:05.000Z",
  completedAt: "2026-08-13T14:01:35.000Z",
  durationMs: 90_000,
  runtimeBoundary: "Tart VM",
};

test("renders run number, short commit, and branch in separate columns", () => {
  const html = renderToStaticMarkup(<RunTable runs={[run]} allowDetails={false} />);
  expect(html).toContain("<th>Run #</th>");
  expect(html).toContain("<th>Commit</th>");
  expect(html).toContain("<th>Branch</th>");
  expect(html).toContain("#11");
  expect(html).toContain("abcdef1");
  expect(html).toContain("main");
  expect(html).toContain("Snazzie");
  expect(html).toContain(`title="${run.commitSha}"`);
  expect(html).toContain(`aria-label="Commit ${run.commitSha}"`);
});

test("links failed runs to their detail page with organization context", () => {
  const failed = { ...run, status: "completed" as const, conclusion: "failure" as const };

  expect(runDetailLink(failed)).toEqual({
    to: "/runs/$runId",
    params: { runId: "run-1" },
    search: { organizationId: "org-1" },
  });
});
