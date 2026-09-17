import { expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunDetail } from "@mars/contracts";

import { RunDetailView, formatResourceValue, jobDetailHref, runDetailFacts } from "./RunDetailView.tsx";
import { ActionGraph, layoutActionGraph } from "./ActionGraph.tsx";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
globalThis.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

function setFlowContainerSize(window: Window) {
  for (const property of ["clientWidth", "offsetWidth"]) {
    Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, get: () => 800 });
  }
  for (const property of ["clientHeight", "offsetHeight"]) {
    Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, get: () => 430 });
  }
}

const detail: RunDetail = {
  id: "run-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  repositoryName: "acme/mars",
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
    runnerName: "mars-lease-1",
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
  actionGraph: { nodes: [{ id: "job-1", name: "macOS smoke", status: "completed", conclusion: "success", durationMs: 80_000 }], edges: [] },
};

const renderView = (data = detail) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <RunDetailView data={data} organizationId="org-1" />
  </QueryClientProvider>,
);

const waitForRender = async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  await promise;
};

test("constructs organization-aware encoded job detail links", () => {
  expect(jobDetailHref("run-1", "org-1", "job-1")).toBe("/runs/run-1?organizationId=org-1#job-job-1");
  expect(jobDetailHref("run/1", "org&1", "job#1")).toBe("/runs/run%2F1?organizationId=org%261#job-job%231");
});

test("maps real run facts and names missing values explicitly", () => {
  expect(runDetailFacts(detail).runner).toBe("mars-lease-1");
  expect(runDetailFacts({ ...detail, startedAt: null, jobs: [{ ...detail.jobs[0], runnerName: null }] })).toMatchObject({
    started: "Not started",
    runner: "Awaiting runner",
  });
});

test("defaults to the dependency graph with complete run context", () => {
  const markup = renderView();
  expect(markup).toContain('role="tablist"');
  expect(markup).toContain(">Graph<");
  expect(markup).toContain(">Metrics<");
  expect(markup).not.toContain(">Logs<");
  expect(markup).toContain('id="run-graph-panel"');
  expect(markup).toContain("Action dependency graph");
  expect(markup).toContain("Select a job in the dependency graph to inspect its logs.");
  expect(markup).not.toContain('class="log-panel"');
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain("acme/mars");
  expect(markup).toContain("Tart VM");
  expect(markup).toContain("main");
  expect(markup).toContain("acoop");
  expect(markup).toContain("commit abcdef012345");
  expect(markup).toContain("mars-lease-1");
  expect(markup).toContain("macOS smoke");
  expect(markup).toContain("1m 20s");
  expect(markup).toContain("success");
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
test("lays dependency edges out after their prerequisites", () => {
  const flow = layoutActionGraph({
    nodes: [
      { id: "build", name: "Build", status: "completed", conclusion: "success", durationMs: 12_000 },
      { id: "test", name: "Test", status: "completed", conclusion: "failure", durationMs: 8_000 },
    ],
    edges: [{ from: "build", to: "test" }],
  });
  expect(flow.edges).toMatchObject([{ source: "build", target: "test" }]);
  expect(flow.nodes.find((node) => node.id === "test")!.position.x).toBeGreaterThan(flow.nodes.find((node) => node.id === "build")!.position.x);
  expect(flow.nodes.find((node) => node.id === "test")!.position.y).toBe(flow.nodes.find((node) => node.id === "build")!.position.y);
});
test("orders parallel branches to avoid crossing dependency edges", () => {
  const flow = layoutActionGraph({
    nodes: [
      { id: "build-a", name: "Compile", status: "completed", conclusion: "success", durationMs: 12_000 },
      { id: "build-b", name: "Package", status: "completed", conclusion: "success", durationMs: 11_000 },
      { id: "test-b", name: "Lint", status: "completed", conclusion: "success", durationMs: 8_000 },
      { id: "test-a", name: "Verify", status: "completed", conclusion: "success", durationMs: 9_000 },
    ],
    edges: [
      { from: "build-a", to: "test-a" },
      { from: "build-b", to: "test-b" },
    ],
  });
  const y = (id: string) => flow.nodes.find((node) => node.id === id)!.position.y;
  expect((y("build-a") - y("build-b")) * (y("test-a") - y("test-b"))).toBeGreaterThan(0);
});
test("connects jobs in display order when dependency metadata is absent", () => {
  const flow = layoutActionGraph({
    nodes: [
      { id: "build", name: "Build", status: "completed", conclusion: "success", durationMs: 12_000 },
      { id: "test", name: "Test", status: "completed", conclusion: "success", durationMs: 8_000 },
      { id: "deploy", name: "Deploy", status: "queued", conclusion: null, durationMs: 0 },
    ],
    edges: [],
  });
  expect(flow.edges).toMatchObject([
    { source: "build", target: "test" },
    { source: "test", target: "deploy" },
  ]);
});
test("deduplicates matrix jobs before mapping dependency edges", () => {
  const flow = layoutActionGraph({
    nodes: [
      { id: "build", name: "Build", status: "completed", conclusion: "success", durationMs: 12_000 },
      { id: "linux", name: "Test linux", status: "completed", conclusion: "success", durationMs: 8_000 },
      { id: "windows", name: "Test windows", status: "completed", conclusion: "failure", durationMs: 9_000 },
      { id: "publish", name: "Publish", status: "queued", conclusion: null, durationMs: 0 },
      { id: "linux", name: "Test linux", status: "completed", conclusion: "success", durationMs: 8_000 },
    ],
    edges: [
      { from: "build", to: "linux" },
      { from: "build", to: "windows" },
      { from: "linux", to: "publish" },
    ],
  });
  const matrix = flow.nodes.find((node) => node.type === "matrix");
  expect(flow.nodes).toHaveLength(3);
  expect(matrix?.type).toBe("matrix");
  if (!matrix || matrix.type !== "matrix") throw new Error("Expected matrix node");
  expect(matrix.data).toMatchObject({ label: "Test", members: [{ id: "linux" }, { id: "windows" }] });
  expect(flow.edges).toHaveLength(2);
  expect(flow.nodes.find((node) => node.id === "build")!.position.x).toBeLessThan(matrix.position.x);
  expect(matrix.position.x).toBeLessThan(flow.nodes.find((node) => node.id === "publish")!.position.x);
});
test("renders matrix groups collapsed until their heading is expanded", async () => {
  const window = new Window();
  setFlowContainerSize(window);
  // @ts-expect-error test DOM globals
  globalThis.document = window.document;
  // @ts-expect-error test DOM globals
  globalThis.window = window;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ActionGraph
      graph={{
        nodes: [
          { id: "linux", name: "Test linux", status: "completed", conclusion: "success", durationMs: 8_000 },
          { id: "windows", name: "Test windows", status: "completed", conclusion: "failure", durationMs: 9_000 },
        ],
        edges: [],
      }}
      selectedNodeId={null}
      onNodeSelect={() => {}}
    />);
    await waitForRender();
  });
  const heading = container.querySelector<HTMLButtonElement>(".matrix-node-heading");
  expect(heading?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".matrix-member")).toBeNull();
  await act(async () => {
    heading?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await waitForRender();
  });
  expect(heading?.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelectorAll(".matrix-member")).toHaveLength(2);
  act(() => root.unmount());
  container.remove();
});
test("keeps a dependent job separate from its matrix siblings", () => {
  const flow = layoutActionGraph({
    nodes: [
      { id: "collect", name: "Screenshots / collect", status: "completed", conclusion: "success", durationMs: 4_000 },
      { id: "chromium", name: "Screenshots / build test (chromium)", status: "completed", conclusion: "success", durationMs: 12_000 },
      { id: "firefox", name: "Screenshots / build test (firefox)", status: "completed", conclusion: "success", durationMs: 13_000 },
    ],
    edges: [
      { from: "collect", to: "chromium" },
      { from: "collect", to: "firefox" },
    ],
  });

  const matrix = flow.nodes.find((node) => node.type === "matrix");
  expect(flow.nodes).toHaveLength(2);
  expect(flow.nodes.find((node) => node.id === "collect")?.type).toBe("action");
  expect(matrix?.type).toBe("matrix");
  if (!matrix || matrix.type !== "matrix") throw new Error("Expected matrix node");
  expect(matrix.data).toMatchObject({
    label: "Screenshots / build test",
    members: [{ id: "chromium" }, { id: "firefox" }],
  });
  expect(flow.edges).toMatchObject([{ source: "collect", target: matrix.id }]);
});






test("selecting a graph node shows only that job's logs", async () => {
  const window = new Window();
  setFlowContainerSize(window);
  // @ts-expect-error test DOM globals
  globalThis.document = window.document;
  // @ts-expect-error test DOM globals
  globalThis.window = window;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
  const container = document.createElement("div");
  document.body.append(container);
  const secondJob = {
    ...detail.jobs[0]!,
    id: "job-2",
    name: "Unit tests",
    runnerName: "mars-lease-2",
    conclusion: "failure" as const,
    failureReason: "out_of_memory" as const,
    oom: {
      reason: "out_of_memory" as const,
      memoryWorkingSetBytes: 11_295_763_988,
      memoryLimitBytes: 10_737_418_240,
      detectedAt: "2026-08-17T20:59:24.015Z",
      gracefulStopAcknowledged: false,
    },
    steps: [{ ...detail.jobs[0]!.steps[0]!, id: "step-2", name: "Test" }],
  };
  const graphDetail = {
    ...detail,
    jobs: [detail.jobs[0]!, secondJob],
    actionGraph: {
      nodes: [...detail.actionGraph.nodes, { id: "job-2", name: "Unit tests", status: "completed" as const, conclusion: "failure", durationMs: 42_000 }],
      edges: [{ from: "job-1", to: "job-2" }],
    },
  };
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RunDetailView data={graphDetail} organizationId="org-1" /></QueryClientProvider>);
    await waitForRender();
  });
  expect(container.querySelector(".log-panel")).toBeNull();
  const jobNode = container.querySelector<HTMLElement>('[data-id="job-2"]');
  expect(jobNode).not.toBeNull();
  await act(async () => {
    jobNode?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await waitForRender();
  });
  expect(jobNode?.classList.contains("selected")).toBe(true);
  expect(container.querySelector("#job-job-2 .log-panel")).not.toBeNull();
  expect(container.querySelector(".graph-panel")?.nextElementSibling).toBe(container.querySelector("#job-job-2"));
  expect(container.querySelector("#job-job-1")).toBeNull();
  expect(container.querySelector("#job-job-2")?.textContent).toContain("Unit tests");
  expect(container.querySelector("#job-job-2")?.textContent).toContain("Test");
  expect(container.querySelector("#job-job-2")?.textContent).toContain("out of memory");
  expect(container.querySelector("#job-job-2")?.textContent).toContain("Memory limit exceeded");
  expect(container.querySelector("#job-job-2")?.textContent).toContain("10.5 GiB");
  expect(container.querySelector("#job-job-2")?.textContent).toContain("10.0 GiB");
  act(() => root.unmount());
  container.remove();
});

test("switches to Metrics without rendering log viewers", async () => {
  const window = new Window();
  setFlowContainerSize(window);
  // @ts-expect-error test DOM globals
  globalThis.document = window.document;
  // @ts-expect-error test DOM globals
  globalThis.window = window;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RunDetailView data={detail} organizationId="org-1" /></QueryClientProvider>);
    await waitForRender();
  });
  const metricsTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-controls="run-metrics-panel"]');
  expect(metricsTab).not.toBeNull();
  await act(async () => {
    metricsTab?.click();
    await waitForRender();
  });
  expect(metricsTab?.getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector('[role="tabpanel"]#run-metrics-panel')).not.toBeNull();
  expect(container.querySelector('a[href="/runs/run-1?organizationId=org-1#job-job-1"]')).not.toBeNull();
  expect(container.querySelector(".log-panel")).toBeNull();
  act(() => root.unmount());
  container.remove();
});
