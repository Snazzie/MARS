import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunStep } from "@whitesmith/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LogViewer, deriveStepDuration, normalizeStepResult } from "./LogViewer.tsx";

const step = (overrides: Partial<RunStep> = {}): RunStep => ({
  id: "step-1",
  name: "Build",
  number: 1,
  status: "completed",
  conclusion: "success",
  queuedAt: "2026-08-13T14:00:00.000Z",
  startedAt: "2026-08-13T14:00:02.000Z",
  completedAt: "2026-08-13T14:00:07.000Z",
  durationMs: 0,
  ...overrides,
});

test("normalizes step result and derives duration from timestamps", () => {
  expect(normalizeStepResult(step())).toBe("success");
  expect(normalizeStepResult(step({ conclusion: "failure" }))).toBe("failure");
  expect(normalizeStepResult(step({ conclusion: "skipped" }))).toBe("skipped");
  expect(normalizeStepResult(step({ status: "in_progress", conclusion: null }))).toBe("in progress");
  expect(deriveStepDuration(step())).toBe(5000);
  expect(deriveStepDuration(step({ completedAt: null }))).toBeNull();
});

test("renders steps collapsed and keeps unattributed job logs as a fallback", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LogViewer
        organizationId="org-1"
        runId="run-1"
        jobId="job-1"
        steps={[step()]}
      />
    </QueryClientProvider>,
  );
  expect(markup).toContain("Build");
  expect(markup).toContain(">success</span>");
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("Unattributed job logs");
  expect(markup).not.toContain("/steps/step-1/logs");
});
