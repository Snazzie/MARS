import { act } from "react";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkerDetail } from "@whitesmith/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkerCard, workerOperationalLabel, workerReadinessLabel } from "./WorkerCard.tsx";

const workerFixture = (overrides: Partial<WorkerDetail> = {}): WorkerDetail => ({
  id: "86afd915-add3-407c-a6c1-1b46803ef713",
  organizationId: null,
  name: "mac-worker",
  platform: "macos-arm64",
  driver: "tart-vm",
  guestPlatforms: ["macos-arm64"],
  admissionState: "adopted",
  connectionState: "online",
  configurationState: "ready",
  configurationRevision: "a".repeat(64),
  appliedConfigurationRevision: "a".repeat(64),
  configurationAppliedAt: "2026-08-16T12:00:00.000Z",
  lastHeartbeatAt: "2026-08-16T12:01:00.000Z",
  lastDoctorAt: "2026-08-16T12:00:30.000Z",
  runtimeMode: "tart",
  artifactDigest: "sha256:" + "b".repeat(64),
  fingerprint: "sha256:worker",
  limits: null,
  doctor: null,
  capacity: { vcpu: { actual: 4, reserved: 0, free: 4 }, memoryBytes: { actual: 8, reserved: 0, free: 8 }, storageBytes: { actual: 10, reserved: 0, free: 10 }, pods: { actual: 1, reserved: 0, free: 1 } },
  activeSandboxes: 0,
  draining: false,
  ...overrides,
});
type WorkerCacheSummary = {
  desiredTtlSeconds: number;
  effectiveTtlSeconds: number | null;
  ready: boolean;
  proxyOrigin: string | null;
  cacheBaseUrl: string | null;
  sizeBytes: string;
  entryCount: number;
  observedAt: string | null;
  error: string | null;
};

const cacheFixture = (overrides: Partial<WorkerCacheSummary> = {}): WorkerCacheSummary => ({
  desiredTtlSeconds: 172800,
  effectiveTtlSeconds: 172800,
  ready: true,
  proxyOrigin: "https://worker.example.test",
  cacheBaseUrl: "https://worker.example.test/_apis/artifactcache",
  sizeBytes: "2147483648",
  entryCount: 0,
  observedAt: "2026-08-16T12:02:00.000Z",
  error: null,
  ...overrides,
});

const cacheWorkerFixture = (overrides: Partial<WorkerDetail> = {}, cache = cacheFixture()) => ({ ...workerFixture(overrides), cache });
const renderCard = (worker: WorkerDetail) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WorkerCard worker={worker} organizationId="all" onChange={() => {}} /></QueryClientProvider>);

test("keeps worker health authoritative and cache inventory compact", () => {
  const markup = renderCard(cacheWorkerFixture());
  expect(markup).toContain("Cache inventory");
  expect(markup).toContain("No cache entries");
  expect(markup).not.toContain("Capacity / actual");
  expect(markup).not.toContain("Action cache");
  expect(markup).not.toContain("cache-summary-grid");
});

test("renders unavailable cache inventory without duplicate health details", () => {
  const markup = renderCard(cacheWorkerFixture({}, cacheFixture({ ready: false, effectiveTtlSeconds: null, error: "Cache proxy unavailable", cacheBaseUrl: null })));
  expect(markup).toContain("Cache inventory unavailable");
  expect(markup).not.toContain("Browse cache inventory");
  expect(markup).not.toContain("Cache proxy unavailable");
});

test("keeps the cache inventory affordance for populated caches", () => {
  const markup = renderCard(cacheWorkerFixture({}, cacheFixture({ entryCount: 1 })));
  expect(markup).toContain("Browse cache inventory");
});

test("lazy-loads a searchable paginated cache inventory", async () => {
  const browser = new Window();
  // @ts-expect-error test DOM globals
  globalThis.document = browser.document;
  // @ts-expect-error test DOM globals
  globalThis.window = browser;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({
      items: [{
        entryId: "entry-1",
        githubRepositoryId: "123",
        repositoryFullName: "acme/widgets",
        repositoryUrl: "https://github.com/acme/widgets",
        cacheKeyPreview: "linux-node-build",
        cacheKeyHash: "a".repeat(64),
        scopePreview: "refs/heads/main",
        scopeHash: "b".repeat(64),
        versionHash: "c".repeat(64),
        sizeBytes: "1048576",
        createdAt: "2026-08-16T12:00:00.000Z",
        lastAccessedAt: "2026-08-16T12:01:00.000Z",
        expiresAt: "2026-08-18T12:01:00.000Z",
      }],
      nextCursor: "next-page",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><WorkerCard worker={cacheWorkerFixture({}, cacheFixture({ entryCount: 1 }))} organizationId="all" onChange={() => {}} /></QueryClientProvider>);
    });
    expect(container.querySelector("table")).toBeNull();
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new browser.Event("toggle") as unknown as Event); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(requested).toBe("/api/workers/86afd915-add3-407c-a6c1-1b46803ef713/cache?limit=25");
    expect(container.querySelector("table")?.textContent).toContain("acme/widgets");
    expect(container.querySelector("table")?.textContent).toContain("linux-node-build");
    expect(container.querySelector("table")?.textContent).toContain("refs/heads/main");
    expect(container.querySelector("table")?.textContent).toContain("1 MiB");
    expect(container.querySelector(".worker-cache-inventory button")?.textContent).toContain("Load more");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("maps worker connection and draining state to operational labels", () => {
  expect(workerOperationalLabel({ connectionState: "online", draining: false })).toBe("Online");
  expect(workerOperationalLabel({ connectionState: "offline", draining: false })).toBe("Offline");
  expect(workerOperationalLabel({ connectionState: "online", draining: true })).toBe("Draining");
});

test("maps worker configuration state to readiness labels", () => {
  expect(workerReadinessLabel("ready")).toBe("Ready");
  expect(workerReadinessLabel("unconfigured")).toBe("Needs configuration");
  expect(workerReadinessLabel("error")).toBe("Error");
  expect(workerReadinessLabel("applying")).toBe("Applying configuration");
});
test("renders operational and readiness status in the worker card", () => {
  const worker = workerFixture();
  const markup = renderCard(worker);
  expect(markup).toContain(">online</span>");
  expect(markup).not.toContain("Needs configuration");
});

test("uses a compact identity and operations layout without artifact or standalone policy rows", () => {
  const markup = renderCard(workerFixture({
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_294_967_296, maxStorageBytesPerPod: 10_737_418_240, maxConcurrentPods: 3 },
  }));
  expect(markup).toContain('class="worker-card-controls"');
  expect(markup).toContain('class="worker-fingerprint"');
  expect(markup).toContain('worker-operational-strip"');
  expect(markup).not.toContain("Artifact digest");
  expect(markup).not.toContain("Policy ceilings");
});

test("shows applying configuration until the desired revision is acknowledged", () => {
  const worker = workerFixture({ configurationState: "applying", configurationRevision: "b".repeat(64), doctor: { egress: true } });
  const markup = renderCard(worker);
  expect(markup).toContain("Applying configuration");
  expect(markup).toContain("Runtime checks pass");
  expect(markup).not.toContain("Ready for dispatch");
  expect(markup).not.toContain("Configuration updated");
});

test("shows the exact applied revision and acknowledgement time", () => {
  const worker = workerFixture();
  const markup = renderCard(worker);
  expect(markup).toContain("Configuration updated");
  expect(markup).toContain("aaaaaaaaaaaa");
  expect(markup).toContain("Aug");
});

test("retains the last successful acknowledgement when an update fails", () => {
  const worker = workerFixture({ configurationState: "error", configurationRevision: "b".repeat(64) });
  const markup = renderCard(worker);
  expect(markup).toContain("Configuration update failed");
  expect(markup).toContain("Last applied");
  expect(markup).toContain("aaaaaaaaaaaa");
});
test("keeps live health visible without expansion controls", () => {
  const markup = renderCard(workerFixture());
  expect(markup).not.toContain("worker-health-toggle");
  expect(markup).not.toContain("Show live health");
  expect(markup).toContain("Live worker health");
});
test("polls live health on mount without an expansion flag", async () => {
  const browser = new Window();
  // @ts-expect-error test DOM globals
  globalThis.document = browser.document;
  // @ts-expect-error test DOM globals
  globalThis.window = browser;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({
      observedAt: null,
      connection: { state: "online", lastHeartbeatAt: null, lastDoctorAt: null, heartbeatAgeSeconds: null, doctorAgeSeconds: null },
      usage: { cpu: { actual: 1, reserved: 0, free: 1 }, memoryBytes: { actual: "1", reserved: "0", free: "1" }, storageBytes: { actual: "1", reserved: "0", free: "1" }, pods: { actual: 1, reserved: 0, free: 1 } },
      cache: { desiredTtlSeconds: 3600, effectiveTtlSeconds: null, ready: false, generation: null, sizeBytes: "0", entryCount: 0, observedAt: null, error: null },
      jobs: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><WorkerCard worker={workerFixture()} organizationId="all" onChange={() => {}} /></QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(requested).toBe("/api/workers/86afd915-add3-407c-a6c1-1b46803ef713/health");
    expect(container.querySelector("#worker-health-86afd915-add3-407c-a6c1-1b46803ef713-panel")).not.toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
