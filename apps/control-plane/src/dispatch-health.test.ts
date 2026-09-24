import { expect, test } from "bun:test";
import { DispatchHealthMonitor } from "./dispatch-health.ts";

test("reports scoped dispatch blockers, recovery, and stale reconciliation", () => {
  const monitor = new DispatchHealthMonitor(5_000, 0);
  expect(monitor.snapshot(["org-a"], 1_000).state).toBe("starting");
  monitor.markSuccess([
    { organizationId: "org-a", jobId: 1, code: "worker_runtime_not_ready" },
    { organizationId: "org-a", jobId: 2, code: "dispatched" },
    { organizationId: "org-b", jobId: 3, code: "github_rate_limited" },
  ], 2_000);
  expect(monitor.snapshot(["org-a"], 2_001)).toEqual({
    state: "healthy", lastReconciledAt: new Date(2_000).toISOString(), queued: 2, reserved: 1,
    reasons: [{ code: "worker_runtime_not_ready", count: 1 }],
  });
  expect(monitor.snapshot(["org-b"], 2_001).reasons).toEqual([{ code: "github_rate_limited", count: 1 }]);
  expect(monitor.snapshot(["org-a"], 17_001).state).toBe("degraded");
  monitor.markFailure();
  expect(monitor.snapshot(["org-a"], 3_000).state).toBe("degraded");
  monitor.markSuccess([], 4_000);
  expect(monitor.snapshot(["org-a"], 4_001)).toMatchObject({ state: "healthy", queued: 0, reasons: [] });
});

test("reports a stalled scheduler even before its first successful pass", () => {
  const monitor = new DispatchHealthMonitor(5_000, 0);
  expect(monitor.snapshot(null, 15_001)).toMatchObject({ state: "degraded", lastReconciledAt: null });
});

test("logs requested labels when a job has no matching pool, including label changes", () => {
  const original = console.log;
  const messages: unknown[][] = [];
  console.log = (...args: unknown[]) => { messages.push(args); };
  try {
    const monitor = new DispatchHealthMonitor(5_000);
    monitor.markSuccess([{ organizationId: "org", jobId: 42, code: "no_matching_labels", labels: ["ubuntu-latest"] }]);
    monitor.markSuccess([{ organizationId: "org", jobId: 42, code: "no_matching_labels", labels: ["ubuntu-latest"] }]);
    monitor.markSuccess([{ organizationId: "org", jobId: 42, code: "no_matching_labels", labels: ["mars-linux-arm64"] }]);
    expect(messages).toEqual([
      ["Job dispatch blocked", { organizationId: "org", jobId: 42, reason: "no_matching_labels", labels: ["ubuntu-latest"] }],
      ["Job dispatch blocked", { organizationId: "org", jobId: 42, reason: "no_matching_labels", labels: ["mars-linux-arm64"] }],
    ]);
  } finally {
    console.log = original;
  }
});

test("logs the pool identity and logs again when its eligibility changes", () => {
  const original = console.log;
  const messages: unknown[][] = [];
  console.log = (...args: unknown[]) => { messages.push(args); };
  try {
    const monitor = new DispatchHealthMonitor(5_000);
    const blocked = { organizationId: "org", jobId: 42, code: "no_eligible_worker_pool", pools: [{ poolId: "pool", poolName: "Windows pool", platform: "windows-x64", reason: "no_current_worker_candidate" }] };
    monitor.markSuccess([blocked]);
    monitor.markSuccess([blocked]);
    monitor.markSuccess([{ ...blocked, pools: [{ ...blocked.pools[0], reason: "pool_disabled" }] }]);
    expect(messages).toEqual([
      ["Job dispatch blocked", { organizationId: "org", jobId: 42, reason: "no_eligible_worker_pool", pools: blocked.pools }],
      ["Job dispatch blocked", { organizationId: "org", jobId: 42, reason: "no_eligible_worker_pool", pools: [{ ...blocked.pools[0], reason: "pool_disabled" }] }],
    ]);
  } finally {
    console.log = original;
  }
});
