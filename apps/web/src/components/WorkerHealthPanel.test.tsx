import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "bun:test";
import type { WorkerHealth } from "@mars/contracts";
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
  cache: { desiredTtlSeconds: 3600, effectiveTtlSeconds: 3600, effectiveRunnerCacheEnabled: true, effectiveRunnerCacheMaxGiB: 20, ready: true, generation: "11111111-1111-4111-8111-111111111111", sizeBytes: "20", entryCount: 2, runnerCacheSizeBytes: "30", runnerCacheEntryCount: 3, observedAt: "2026-08-23T11:59:57.000Z", runnerCacheObservedAt: "2026-08-23T11:59:56.000Z", error: null },
  containers: [],
  jobs: [{
    jobId: 7,
    repositoryFullName: "acme/repo",
    repositoryName: "repo",
    leaseId: "22222222-2222-4222-8222-222222222222",
    state: "busy",
    startedAt: "2026-08-23T11:59:56.000Z",
    ageSeconds: 3,
    requested: { vcpu: 1, memoryBytes: "536870912", storageBytes: "100", concurrency: 1 },
  }],
  ...overrides,
});

test("renders usage, cache health, and workload telemetry with accessible sections", () => {
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture()} />);
  expect(markup).toContain("System usage");
  expect(markup).toContain("Cache health");
  expect(markup).toContain("Managed containers");
  expect(markup).toContain("Unassigned jobs");
  expect(markup).toContain("Actual");
  expect(markup).toContain("Desired TTL");
  expect(markup).toContain("acme/repo");
  expect(markup).toContain("512 MiB");
  expect(markup).toContain("Actions entries");
  expect(markup).toContain("Actions size");
  expect(markup).toContain("Runner cache enabled");
  expect(markup).toContain("Runner cache capacity");
  expect(markup).toContain("Runner cache entries");
  expect(markup).toContain("Runner cache size");
  expect(markup).toContain("Runner cache observed");
  expect(markup).toContain("<time dateTime=\"2026-08-23T11:59:56.000Z\">");
});

test("splits requested job resources into separately scoped columns", () => {
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture({
    jobs: [{
      ...healthFixture().jobs[0],
      requested: { vcpu: 2, memoryBytes: "2147483648", storageBytes: "10737418240", concurrency: 3 },
    }],
  })} />);
  for (const heading of ["vCPU", "Memory", "Storage", "Concurrency"]) {
    expect(markup).toContain(`<th scope="col">${heading}</th>`);
  }
  expect(markup).toContain("<td>- / 2</td>");
  expect(markup).toContain("<td>- / 2.0 GiB</td>");
  expect(markup).toContain("<td>- / 10.0 GiB</td>");
  expect(markup).toContain("<td>- / 3</td>");
  expect(markup).not.toContain("Requested vCPU / memory / storage / concurrency");
});

test("formats very large decimal byte strings with safe binary units", () => {
  const huge = "900719925474099300000";
  const health = healthFixture({ usage: { ...healthFixture().usage, memoryBytes: { actual: huge, reserved: huge, free: huge } } });
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={health} />);
  expect(markup).toContain("819200000.0 TiB");
  expect(markup).not.toContain(`${huge} B`);
});
test("combines resource usage into one accessible table with labeled allocation bars", () => {
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture()} />);
  expect(markup).toContain('<table class="worker-health-usage-table">');
  expect(markup).toContain("<th scope=\"col\">Worker capacity</th>");
  expect(markup).toContain("<th scope=\"col\">Reserved by workers</th>");
  expect(markup).toContain("<th scope=\"col\">Available</th>");
  for (const resource of ["CPU", "Memory", "Storage", "Pods"]) expect(markup).toContain(`<th scope="row">${resource}</th>`);
  expect(markup).toContain("Actual capacity");
  expect(markup).toContain("Reserved by workers");
  expect(markup).toContain("Available");
  expect(markup).toContain('role="img"');
  expect(markup).toContain("CPU: 1 reserved by workers, 1 available");
});

test("merges configured policy ceilings into system usage", () => {
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture()} limits={{
    maxVcpuPerPod: 2,
    maxMemoryBytesPerPod: 4_294_967_296,
    maxStorageBytesPerPod: 10_737_418_240,
    maxConcurrentPods: 3,
  }} />);
  expect(markup).toContain("<th scope=\"col\">Per-job ceiling</th>");
  expect(markup).toContain("4.0 GiB");
  expect(markup).toContain("10.0 GiB");
  expect(markup).toContain(">3</td>");
});

test("keeps zero-total allocation bars finite", () => {
  const zero = { actual: 0, reserved: 0, free: 0 };
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture({
    usage: { cpu: zero, memoryBytes: { actual: "0", reserved: "0", free: "0" }, storageBytes: { actual: "0", reserved: "0", free: "0" }, pods: zero },
  })} />);
  expect(markup).not.toMatch(/(?:NaN|Infinity)%/);
  expect(markup).toContain('style="width:0%"');
  expect(markup).not.toContain('style="width:100%"');
});

test("formats each resource byte value with friendly binary units", () => {
  const health = healthFixture({ usage: { ...healthFixture().usage, memoryBytes: { actual: "536870912", reserved: "536870912", free: "536870912" } } });
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={health} />);
  expect(markup.match(/512 MiB/g)?.length).toBeGreaterThanOrEqual(3);
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
  expect(markup).toContain('aria-labelledby="worker-health-worker-42-containers-heading"');
  expect(markup).not.toContain('aria-labelledby="worker-health-worker-42-jobs-heading"');
});

test("renders managed containers with their matching jobs and explicit unmatched workload states", () => {
  const sampledRecently = new Date(Date.now() - 59_500).toISOString();
  const sampledEarlier = new Date(Date.now() - 125_000).toISOString();
  const markup = renderToStaticMarkup(<WorkerHealthPanel workerId="worker-42" health={healthFixture({
    containers: [
      { containerId: "a".repeat(64), name: "alpha", leaseId: "33333333-3333-4333-8333-333333333333", state: "running", cpuUsagePercent: 12.34, memoryWorkingSetBytes: "536870912", memoryLimitBytes: "1073741824", diskUsageBytes: "2147483648", sampledAt: sampledRecently },
      { containerId: "b".repeat(64), name: "beta", leaseId: "44444444-4444-4444-8444-444444444444", state: "exited", cpuUsagePercent: null, memoryWorkingSetBytes: null, memoryLimitBytes: null, diskUsageBytes: "0", sampledAt: sampledEarlier },
    ],
    jobs: [
      { jobId: 42, repositoryFullName: "acme/project", repositoryName: "project", leaseId: "33333333-3333-4333-8333-333333333333", state: "running", startedAt: "2026-08-23T11:59:56.000Z", ageSeconds: 3, requested: { vcpu: 2, memoryBytes: "1073741824", storageBytes: "2147483648", concurrency: 2 } },
      { jobId: 99, repositoryFullName: "acme/unassigned", repositoryName: "unassigned", leaseId: "66666666-6666-4666-8666-666666666666", state: "queued", startedAt: null, ageSeconds: null, requested: { vcpu: 1, memoryBytes: "536870912", storageBytes: "100", concurrency: 1 } },
    ],
  })} />);
  expect(markup).toContain("Managed containers");
  expect(markup).toContain("<caption>Current managed containers and resource usage</caption>");
  for (const heading of ["Container", "State", "CPU", "Memory", "Disk", "Freshness", "Job ID", "Repository / name", "Lease state", "Age", "vCPU", "Storage", "Concurrency"]) expect(markup).toContain(`<th scope="col">${heading}</th>`);
  expect(markup).toContain("<strong>alpha</strong>");
  expect(markup).toContain("<strong>beta</strong>");
  const rows = [...markup.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(([row]) => row);
  const alphaRow = rows.find((row) => row.includes("<strong>alpha</strong>")) ?? "";
  expect(alphaRow).toContain("<td>42</td>");
  expect(alphaRow).toContain("acme/project");
  expect(alphaRow).not.toContain("acme/unassigned");
  const betaRow = rows.find((row) => row.includes("<strong>beta</strong>")) ?? "";
  expect(betaRow).toContain("No job assigned");
  expect(betaRow).not.toContain("<td>42</td>");
  expect(betaRow).not.toContain("acme/project");
  expect(markup).toContain("Unassigned jobs");
  expect(markup).toContain("<td>99</td>");
  expect(markup).toContain("acme/unassigned");
  expect(markup).toContain('title="' + "a".repeat(64) + '"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).toContain("aaaaaaaaaaaa…");
  expect(markup).toContain("running");
  expect(markup).toContain("exited");
  expect(markup).toContain("12.3%");
  expect(markup).toContain("512 MiB");
  expect(markup).toContain("of 1.0 GiB");
  const text = markup.replace(/<[^>]+>/g, "");
  expect(text).toContain("512 MiB of 1.0 GiB");
  expect(text).toContain("2.0 GiB Writable-layer use");
  expect(markup).toContain("2.0 GiB");
  expect(markup).toContain("Writable-layer use");
  expect(markup).toContain("0 B");
  expect(markup).toContain("Not reported");
  expect(markup).toContain("60s ago");
  expect(markup).not.toContain("1m ago");
  expect(markup).toContain("2m ago");
  expect(markup).toContain(`<time dateTime="${sampledRecently}">`);
  expect(markup).toContain(`<time dateTime="${sampledEarlier}">`);
});

test("renders an explicit empty managed-container inventory", () => {
  const markup = renderToStaticMarkup(<WorkerHealthPanel health={healthFixture({ containers: [] })} />);
  expect(markup).toContain("No managed containers reported.");
  expect(markup).not.toContain("Current managed containers and resource usage");
});

test("keeps managed-container section IDs distinct for each worker", () => {
  const health = healthFixture({ containers: [{
    containerId: "c".repeat(64), name: "gamma", leaseId: "55555555-5555-4555-8555-555555555555", state: "paused", cpuUsagePercent: null, memoryWorkingSetBytes: null, memoryLimitBytes: null, diskUsageBytes: null, sampledAt: new Date().toISOString(),
  }] });
  const first = renderToStaticMarkup(<WorkerHealthPanel workerId="worker-a" health={health} />);
  const second = renderToStaticMarkup(<WorkerHealthPanel workerId="worker-b" health={health} />);
  expect(first).toContain('id="worker-health-worker-a-containers-heading"');
  expect(second).toContain('id="worker-health-worker-b-containers-heading"');
  expect(first).not.toContain("worker-health-worker-b");
  expect(second).not.toContain("worker-health-worker-a");
});
