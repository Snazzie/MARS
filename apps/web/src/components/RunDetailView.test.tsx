import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunDetail } from "@whitesmith/contracts";
import { RunDetailView, formatResourceValue, runDetailFacts } from "./RunDetailView.tsx";

const detail: RunDetail = {
  id: "run-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryName: "acme/whitesmith",
  runNumber: 42,
  workflowName: "macos-smoke.yml",
  event: "workflow_dispatch",
  branch: "main",
  commitSha: "abcdef0123456789abcdef0123456789abcdef01",
  actorLogin: "acoop",
  status: "completed",
  conclusion: "success",
  queuedAt: "2026-08-13T14:00:00.000Z",
  startedAt: "2026-08-13T14:00:05.000Z",
  completedAt: "2026-08-13T14:01:35.000Z",
  durationMs: 90000,
  runtimeBoundary: "Tart VM",
  jobs: [{
    id: "job-1",
    name: "macOS smoke",
    status: "completed",
    conclusion: "success",
    stage: "completed",
    runnerName: "whitesmith-lease-1",
    logsState: "pending",
    requested: { vcpu: 2, memoryBytes: 4_294_967_296, storageBytes: 10_737_418_240, concurrency: 3 },
    requestedLabels: ["self-hosted", "macos", "arm64"],
    observed: { vcpu: 2, memoryBytes: 4_294_967_296, storageBytes: 10_737_418_240, concurrency: 3 },
    steps: [{
      id: "step-1", name: "Build", number: 1, status: "completed", conclusion: "success",
      queuedAt: "2026-08-13T14:00:05.000Z", startedAt: "2026-08-13T14:00:10.000Z", completedAt: "2026-08-13T14:01:30.000Z", durationMs: 0,
    }],
  }],
  stages: [{ stage: "completed", startedAt: "2026-08-13T14:00:05.000Z", completedAt: "2026-08-13T14:01:35.000Z", durationMs: 90000 }],
  actionGraph: { nodes: [{ id: "job-1", name: "macOS smoke", status: "completed" }], edges: [] },
};

const renderView = (data = detail) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <RunDetailView data={data} organizationId="org-1" />
  </QueryClientProvider>,
);

test("maps real run facts and names missing values explicitly", () => {
  expect(runDetailFacts(detail).runner).toBe("whitesmith-lease-1");
  expect(runDetailFacts({ ...detail, startedAt: null, jobs: [{ ...detail.jobs[0], runnerName: null }] })).toMatchObject({
    started: "Not started",
    runner: "Awaiting runner",
  });
});

test("renders only semantic Logs and Metrics tabs with complete run context", () => {
  const markup = renderView();
  expect(markup).toContain('role="tablist"');
  expect(markup).toContain("Logs");
  expect(markup).toContain("Metrics");
  expect(markup).not.toContain("Network");
  expect(markup).not.toContain("Tests");
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain("acme/whitesmith");
  expect(markup).toContain("Tart VM");
  expect(markup).toContain("main");
  expect(markup).toContain("acoop");
  expect(markup).toContain("commit abcdef012345");
  expect(markup).toContain("whitesmith-lease-1");
  expect(markup).toContain("self-hosted");
  expect(markup).toContain("macos");
  expect(markup).toContain("arm64");
  expect(markup).toContain("abcdef012345");
  expect(markup).toContain("status-success");
});
test("labels concurrency as scheduler slots rather than vCPU", () => {
  expect(formatResourceValue(3, "slots")).toBe("3 slots");
  expect(formatResourceValue(3, "slots")).not.toBe("3 vCPU");
});
test("renders an awaiting-runner badge when no runner is assigned", () => {
  const markup = renderView({ ...detail, jobs: [{ ...detail.jobs[0], runnerName: null }] });
  expect(markup).toContain("Awaiting runner");
});

test("renders an actionable OOM diagnosis", () => {
  const markup = renderView({
    ...detail,
    jobs: [{
      ...detail.jobs[0]!,
      conclusion: "failure",
      failureReason: "out_of_memory",
      oom: {
        reason: "out_of_memory",
        memoryWorkingSetBytes: 11_295_763_988,
        memoryLimitBytes: 10_737_418_240,
        detectedAt: "2026-08-17T20:59:24.015Z",
        gracefulStopAcknowledged: false,
      },
    }],
  });
  expect(markup).toContain("out of memory");
  expect(markup).toContain("Memory limit exceeded");
  expect(markup).toContain("10.5 GiB");
  expect(markup).toContain("10.0 GiB");
});

test("switches to Metrics without rendering log viewers", async () => {
  const window = new Window();
  // @ts-expect-error test DOM globals
  globalThis.document = window.document;
  // @ts-expect-error test DOM globals
  globalThis.window = window;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RunDetailView data={detail} organizationId="org-1" /></QueryClientProvider>);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const metricsTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-controls="run-metrics-panel"]');
  expect(metricsTab).not.toBeNull();
  metricsTab?.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(metricsTab?.getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector('[role="tabpanel"]#run-metrics-panel')).not.toBeNull();
  expect(container.querySelector(".log-panel")).toBeNull();
  root.unmount();
});
