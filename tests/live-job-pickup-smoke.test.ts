import { describe, expect, test } from "bun:test";
import {
  advanceFreshRunMilestones,
  assertExpectedControlPlaneBuild,
  initialFreshRunMilestones,
  isMarsRunnerName,
  selectFreshWorkflowRun,
  type FreshRunSnapshot,
} from "./live-job-pickup-smoke.ts";

describe("live job pickup smoke helpers", () => {
  test("accepts only lease-correlated Mars runner names", () => {
    expect(isMarsRunnerName("mars-123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isMarsRunnerName("mars-debug-123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(isMarsRunnerName("mars-123e4567-e89b-12d3-a456-42661417400z")).toBe(false);
    expect(isMarsRunnerName(null)).toBe(false);
  });

  test("selects a newly dispatched workflow run instead of a baseline run", () => {
    const run = selectFreshWorkflowRun([
      { id: 900, event: "workflow_dispatch", status: "completed", conclusion: "success", createdAt: "2026-08-13T12:00:00Z" },
      { id: 902, event: "push", status: "queued", conclusion: null, createdAt: "2026-08-13T12:02:00Z" },
      { id: 901, event: "workflow_dispatch", status: "queued", conclusion: null, createdAt: "2026-08-13T12:01:00Z" },
    ], new Set([900]));

    expect(run?.id).toBe(901);
  });
  test("requires the live control plane to report the expected healthy build", () => {
    const health = {
      ok: true,
      buildId: "build-20260813",
      startedAt: "2026-08-13T18:00:00.000Z",
      discovery: {
        lastAttemptAt: "2026-08-13T18:00:30.000Z",
        lastSuccessAt: "2026-08-13T18:00:31.000Z",
        stale: false,
        staleAfterMs: 60_000,
      },
    };

    expect(() => assertExpectedControlPlaneBuild(health, "build-20260813")).not.toThrow();
    expect(() => assertExpectedControlPlaneBuild(health, "old-build")).toThrow("control_plane_build_mismatch");
    expect(() => assertExpectedControlPlaneBuild({ ...health, ok: false, discovery: { ...health.discovery, stale: true } }, "build-20260813")).toThrow("control_plane_discovery_stale");
  });


  test("records fresh-run proof only in the required lifecycle order", () => {
    const base: FreshRunSnapshot = {
      githubStatus: "queued",
      githubConclusion: null,
      databaseRunStatus: "queued",
      databaseJobStatus: "queued",
      runnerName: null,
      leaseId: null,
      leaseState: null,
      pending: 1,
    };

    const queued = advanceFreshRunMilestones(initialFreshRunMilestones(), base);
    expect(queued).toEqual({ queued: true, lease: false, inProgress: false, terminal: false, reaped: false, pendingZero: false });

    const lease = advanceFreshRunMilestones(queued, { ...base, leaseId: "123e4567-e89b-12d3-a456-426614174000", leaseState: "dispatched" });
    expect(lease.lease).toBe(true);

    const inProgress = advanceFreshRunMilestones(lease, { ...base, githubStatus: "in_progress", databaseRunStatus: "in_progress", databaseJobStatus: "in_progress", runnerName: "mars-123e4567-e89b-12d3-a456-426614174000", leaseId: "123e4567-e89b-12d3-a456-426614174000", leaseState: "busy", pending: 0 });
    expect(inProgress.inProgress).toBe(true);

    const terminal = advanceFreshRunMilestones(inProgress, { ...base, githubStatus: "completed", githubConclusion: "success", databaseRunStatus: "completed", databaseJobStatus: "completed", runnerName: "mars-123e4567-e89b-12d3-a456-426614174000", leaseId: "123e4567-e89b-12d3-a456-426614174000", leaseState: "completed", pending: 0 });
    expect(terminal.terminal).toBe(true);
    expect(terminal.reaped).toBe(false);

    const completed = advanceFreshRunMilestones(terminal, { ...base, githubStatus: "completed", githubConclusion: "success", databaseRunStatus: "completed", databaseJobStatus: "completed", runnerName: "mars-123e4567-e89b-12d3-a456-426614174000", leaseId: "123e4567-e89b-12d3-a456-426614174000", leaseState: "reaped", pending: 0 });
    expect(completed).toEqual({ queued: true, lease: true, inProgress: true, terminal: true, reaped: true, pendingZero: true });
  });

  test("does not infer missed lifecycle milestones from a terminal snapshot", () => {
    const terminalOnly = advanceFreshRunMilestones(initialFreshRunMilestones(), {
      githubStatus: "completed",
      githubConclusion: "success",
      databaseRunStatus: "completed",
      databaseJobStatus: "completed",
      runnerName: "mars-123e4567-e89b-12d3-a456-426614174000",
      leaseId: "123e4567-e89b-12d3-a456-426614174000",
      leaseState: "reaped",
      pending: 0,
    });

    expect(terminalOnly).toEqual(initialFreshRunMilestones());
  });
});
