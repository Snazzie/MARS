import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { ReportingPeriodControl, reportingPeriodLabels } from "../components/ReportingPeriodControl.tsx";
import { GithubRunnerCostDisclosure } from "../components/GithubRunnerCostDisclosure.tsx";
import { formatMinutes, formatUsdMicros } from "../format.ts";
import { ControlPlaneStatus } from "./OverviewPage.tsx";
const load = { running: 2, concurrency: 8, utilization: { pods: .25, vcpu: .2, memory: .1, storage: .1 } };

test("merged qualification metric retains eligible and total queued counts independently", () => {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(<ControlPlaneStatus load={load} awaiting={7} queueReasons={[{ code: "eligible", count: 3 }]} status={{
    state: "healthy", lastReconciledAt: null, queued: 0, reserved: 0, reasons: [],
  }} />);
  const values = Array.from(window.document.querySelectorAll(".dispatch-metrics dd")).map(node => node.textContent);
  expect(values).toEqual(["2 / 8", "3 / 7", "— / —"]);
  window.document.body.innerHTML = renderToStaticMarkup(<ControlPlaneStatus status={undefined} load={{ ...load, concurrency: 0 }} awaiting={7} />);
  expect(Array.from(window.document.querySelectorAll(".dispatch-metrics dd")).map(node => node.textContent)).toEqual(["2 / —", "— / 7"]);
});


test("period control exposes all supported reporting windows", () => {
  const markup = renderToStaticMarkup(<ReportingPeriodControl value="24h" onChange={() => {}} label="Overview time window" />);
  expect(markup).toContain('aria-label="Overview time window"');
  expect(markup).toContain('value="24h"');
  expect(markup).toContain('value="7d"');
  expect(markup).toContain('value="30d"');
  expect(markup).toContain('checked=""');
  expect(reportingPeriodLabels["30d"]).toBe("30 days");
});
test("dispatcher separates queued jobs excluded before scheduling from workers rejected by pool eligibility", () => {
  const markup = renderToStaticMarkup(<ControlPlaneStatus load={load} awaiting={4} queueReasons={[
    { code: "run_not_dispatchable", count: 3 }, { code: "eligible", count: 1 },
  ]} status={{
    state: "healthy", lastReconciledAt: "2026-09-24T02:17:00.000Z", queued: 1, reserved: 0,
    reasons: [{ code: "no_eligible_worker_pool", count: 1 }],
    nextScheduledAt: "2026-09-24T02:17:05.000Z", intervalMs: 5_000,
    currentPoolsObservedAt: "2026-09-24T02:17:02.000Z",
    currentPools: [{ poolId: "pool", poolName: "Windows", platform: "windows-x64", workerId: "worker", workerName: "BEAST", reason: "worker_doctor_stale" }],
    blockedJobs: [{ jobId: 42, code: "no_eligible_worker_pool", labels: ["mars-windows-x64-2vcpu-4g"],
      pools: [{ poolId: "pool", poolName: "Windows", platform: "windows-x64", workerId: "worker", workerName: "BEAST", reason: "worker_doctor_stale" }] }],
  }} />);
  expect(markup).toContain("Parent run is no longer queued or in progress");
  expect(markup).toContain("Worker runtime report is older than 60 seconds");
  expect(markup).toContain("Waiting for an eligible worker and pool");
});
test("blocked job links identify repository and job name and target the GitHub job", () => {
  const markup = renderToStaticMarkup(<ControlPlaneStatus load={load} status={{
    state: "healthy", lastReconciledAt: "2026-09-27T08:23:21.000Z", queued: 1, reserved: 0,
    reasons: [{ code: "invalid_provision_labels", count: 1 }],
    blockedJobs: [{ jobId: 108558550787, code: "invalid_provision_labels", labels: ["mars-ubuntu-arm64"], repository: "BetterTaskManager/BetterTaskManagerPrivate", githubRunId: "35985554985", jobName: "Build and test (Ubuntu)" }],
  }} />);
  expect(markup).toContain('href="https://github.com/BetterTaskManager/BetterTaskManagerPrivate/actions/runs/35985554985/job/108558550787"');
  expect(markup).toContain("BetterTaskManager/BetterTaskManagerPrivate · Build and test (Ubuntu)");
  expect(markup).toContain("mars-ubuntu-arm64");
});

test("stale prior blockers do not masquerade as current eligibility while cleanup delays dispatch", () => {
  const markup = renderToStaticMarkup(<ControlPlaneStatus load={load} awaiting={2} queueReasons={[{ code: "eligible", count: 2 }]} status={{
    state: "degraded", healthReason: "reconciliation_stale", lastReconciledAt: "2026-09-27T22:31:21.000Z", queued: 1, reserved: 0,
    reasons: [{ code: "no_eligible_worker_pool", count: 1 }],
    currentPhase: "github_lease_reconciliation", phaseSince: "2026-09-27T22:31:22.000Z",
    dispatchPending: true, intervalMs: 5_000, nextScheduledAt: "2026-09-27T22:31:25.000Z",
    currentPools: [{ poolId: "pool", poolName: "Mac", platform: "macos-arm64", workerName: "Mac.local", reason: "admissible" }],
  }} />);
  expect(markup).toContain("Checking existing leases with GitHub");
  expect(markup).toContain("Another dispatch pass is queued as soon as the current cycle finishes");
  expect(markup).toContain("previous pass below is historical");
});


test("shared cost formatting and disclosure preserve money boundaries", () => {
  const costSavings = { selfHostedMinutes: 1234, pricedMinutes: 1200, unpricedMinutes: 34, estimatedSavingsMicros: 9_000, currency: "USD" as const, latestRateEffectiveFrom: "2026-01-01" };
  const markup = renderToStaticMarkup(<GithubRunnerCostDisclosure costSavings={costSavings} />);
  expect(formatMinutes(1234)).toBe("1,234 min");
  expect(formatUsdMicros(0)).toBe("$0.00");
  expect(formatUsdMicros(1)).toBe("<$0.01");
  expect(formatUsdMicros(10_000)).toBe("$0.01");
  expect(markup).toContain("Dated GitHub-hosted rates are applied by job completion date.");
  expect(markup).toContain("Each completed Mars job is rounded independently.");
  expect(markup).toContain("34 min could not be matched");
  expect(markup).toContain("Latest applied rate: Jan 1, 2026.");
});
