import { describe, expect, test } from "bun:test";
import { ApiError, CreatePoolRequest, CursorPage, OnboardingStep, OverviewDto, RepositorySummary, RunDetail } from "../packages/contracts/src/index.ts";

const run = { id: "run-1", organizationId: "org-1", repositoryId: "repo-1", repositoryName: "acme/app", runNumber: 4, workflowName: "CI", event: "workflow_dispatch", branch: "main", commitSha: "0123456789abcdef", actorLogin: "octocat", status: "completed" as const, conclusion: "success" as const, queuedAt: "2026-08-11T10:00:00Z", startedAt: "2026-08-11T10:01:00Z", completedAt: "2026-08-11T10:02:00Z", durationMs: 60_000, runtimeBoundary: "Kata VM-backed container" as const };

describe("dashboard contracts", () => {
  test("parses valid overview, repository, run detail, and cursor page", () => {
    expect(OverviewDto.safeParse({ organizationId: "org-1", period: "24h", queued: 0, running: 1, completed: 2, failed: 0, queueP50Ms: 1, queueP95Ms: 2, durationP50Ms: 3, durationP95Ms: 4, concurrency: 1, utilization: { vcpu: .5, memory: .25, storage: 0, pods: 1 }, timeseries: [{ bucket: "2026-08-11T10:00:00Z", pending: 0, running: 1 }] }).success).toBe(true);
    const legacyOverview = OverviewDto.safeParse({ organizationId: "org-1", period: "24h", queued: 0, running: 0, completed: 0, failed: 0, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 0, utilization: { vcpu: 0, memory: 0, storage: 0, pods: 0 } });
    expect(legacyOverview.success).toBe(true);
    if (legacyOverview.success) expect(legacyOverview.data.timeseries).toEqual([]);
    const repository = { id: "repo-1", organizationId: "org-1", name: "app", fullName: "acme/app", visibility: "private", available: true, installationId: "inst-1" };
    expect(RepositorySummary.safeParse(repository).success).toBe(true);
    expect(RepositorySummary.safeParse({ ...repository, approved: true }).success).toBe(false);
    expect(RepositorySummary.safeParse({ id: "repo-1", organizationId: "org-1", name: "app", fullName: "acme/app", private: true, installationId: "inst-1" }).success).toBe(false);
    expect(OnboardingStep.safeParse("resources").success).toBe(false);
    const detail = { ...run, jobs: [], stages: [{ stage: "queued" as const, startedAt: run.queuedAt, completedAt: run.startedAt, durationMs: 60_000 }], actionGraph: { nodes: [], edges: [] } };
    expect(RunDetail.safeParse(detail).success).toBe(true);
    expect(RunDetail.safeParse({ ...detail, stages: [{ ...detail.stages[0], startedAt: "bad" }] }).success).toBe(false);
  });
  test("accepts immutable VM template and OCI image digests", () => {
    const request = {
      workerId: "00000000-0000-4000-8000-000000000001",
      name: "default",
      guestPlatform: "windows-x64",
      resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 },
      triggerLabel: "whitesmith-default",
    };
    expect(CreatePoolRequest.safeParse({ ...request, imageDigest: `sha256:${"a".repeat(64)}` }).success).toBe(true);
    expect(CreatePoolRequest.safeParse({ ...request, imageDigest: `windows-template@sha256:${"a".repeat(64)}` }).success).toBe(true);
    expect(CreatePoolRequest.safeParse({ ...request, imageDigest: "sha256:not-a-digest" }).success).toBe(false);
  });
  test("rejects malformed timestamps and cursors", () => {
    expect(RunDetail.safeParse({ ...run, queuedAt: "not-a-time", jobs: [], actionGraph: { nodes: [], edges: [] } }).success).toBe(false);
    expect(CursorPage(RunDetail).safeParse({ items: [], nextCursor: "not valid cursor" }).success).toBe(false);
  });
  test("rejects secret-like keys, including nested DTO payloads", () => {
    expect(ApiError.safeParse({ code: "bad", message: "bad", requestId: "req", details: { accessToken: "redacted" } }).success).toBe(false);
    expect(OverviewDto.safeParse({ organizationId: "org-1", period: "24h", queued: 0, running: 0, completed: 0, failed: 0, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 0, utilization: { vcpu: 0, memory: 0, storage: 0, pods: 0 }, privateKey: "redacted" }).success).toBe(false);
  });
});
