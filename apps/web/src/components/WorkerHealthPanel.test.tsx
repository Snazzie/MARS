import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import type { WorkerHealth } from "@whitesmith/contracts";
import { WorkerHealthPanel } from "./WorkerHealthPanel.tsx";

const healthFixture = (overrides: Partial<WorkerHealth> = {}): WorkerHealth => ({
  observedAt: "2026-08-23T12:00:00.000Z",
  connection: { state: "online", lastHeartbeatAt: "2026-08-23T11:59:59.000Z", lastDoctorAt: "2026-08-23T11:59:58.000Z", heartbeatAgeSeconds: 1, doctorAgeSeconds: 2 },
  usage: {
    cpu: { actual: 2, reserved: 1, free: 1 },
    memoryBytes: { actual: "100", reserved: "40", free: "60" },
    storageBytes: { actual: "1000", reserved: "400", free: "600" },
    pods: { actual: 2, reserved: 1, free: 1 },
  },
  cache: { desiredTtlSeconds: 3600, effectiveTtlSeconds: 3600, ready: true, generation: "11111111-1111-4111-8111-111111111111", sizeBytes: "20", entryCount: 2, observedAt: "2026-08-23T11:59:57.000Z", error: null },
  jobs: [{
    jobId: 7,
    repositoryFullName: "acme/repo",
    repositoryName: "repo",
    leaseId: "22222222-2222-4222-8222-222222222222",
    state: "busy",
    startedAt: "2026-08-23T11:59:56.000Z",
    ageSeconds: 3,
    requested: { vcpu: 1, memoryBytes: "40", storageBytes: "100", concurrency: 1 },
  }],
  ...overrides,
});

test("renders usage, cache health, and running jobs with accessible sections", () => {
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture()} />);
  expect(markup).toContain("System usage");
  expect(markup).toContain("Cache health");
  expect(markup).toContain("Running jobs");
  expect(markup).toContain("Actual");
  expect(markup).toContain("Desired TTL");
  expect(markup).toContain("acme/repo");
  expect(markup).toContain("<caption>Running worker jobs</caption>");
  expect(markup).toContain("<time dateTime=\"2026-08-23T11:59:56.000Z\">");
});

test("preserves large decimal byte strings without unsafe numeric conversion", () => {
  const huge = "900719925474099300000";
  const health = healthFixture({ usage: { ...healthFixture().usage, memoryBytes: { actual: huge, reserved: huge, free: huge } } });
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={health} />);
  expect(markup).toContain(`${huge} B`);
});

test("distinguishes stale, offline, empty, and unavailable telemetry states", () => {
  const health = healthFixture({
    connection: { state: "offline", lastHeartbeatAt: null, lastDoctorAt: null, heartbeatAgeSeconds: 301, doctorAgeSeconds: 601 },
    cache: { ...healthFixture().cache, ready: false, generation: null, observedAt: null, entryCount: 0 },
    jobs: [],
  });
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={health} />);
  expect(markup).toContain("Offline");
  expect(markup).toContain("Stale heartbeat");
  expect(markup).toContain("Stale doctor");
  expect(markup).toContain("No cache snapshot");
  expect(markup).toContain("No active jobs");
  expect(markup).toContain("Unavailable telemetry");
});

test("keeps jobs visible when cache reports an error", () => {
  const health = healthFixture({ cache: { ...healthFixture().cache, error: "cache daemon unavailable" } });
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={health} />);
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("cache daemon unavailable");
  expect(markup).toContain("acme/repo");
});

test("renders independent loading and error states", () => {
  expect(renderToStaticMarkup(<WorkerHealthPanel loading />)).toContain('role="status"');
  expect(renderToStaticMarkup(<WorkerHealthPanel error={new Error("health endpoint unavailable")} />)).toContain('role="alert"');
});
test("marks cache age from observedAt without treating fresh non-ready telemetry as stale", () => {
  const freshObservedAt = new Date(Date.now() - 1_000).toISOString();
  const freshMarkup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture({ cache: { ...healthFixture().cache, ready: false, observedAt: freshObservedAt } })} />);
  expect(freshMarkup).not.toContain("Stale cache");
  const oldObservedAt = new Date(Date.now() - 10_000 * 1_000).toISOString();
  const oldMarkup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture({ cache: { ...healthFixture().cache, ready: true, observedAt: oldObservedAt } })} />);
  expect(oldMarkup).toContain("Stale cache");
});

test("prefixes panel and subsection IDs per worker", () => {
  const markup = renderToStaticMarkup(<WorkerHealthPanel workerId="worker-42" health={healthFixture()} />);
  expect(markup).toContain('id="worker-health-worker-42-panel"');
  expect(markup).toContain('aria-labelledby="worker-health-worker-42-usage-heading"');
  expect(markup).toContain('aria-labelledby="worker-health-worker-42-cache-heading"');
  expect(markup).toContain('aria-labelledby="worker-health-worker-42-jobs-heading"');
});
