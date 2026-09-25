import { describe, expect, test } from "bun:test";
import { ApiError, CostCenterDto, CostCenterPricingProvider, CreatePoolRequest, CursorPage, OnboardingStep, OverviewDto, RepositorySummary, RunDetail, WorkerDetail } from "../packages/contracts/src/index.ts";

const run = { id: "run-1", organizationId: "org-1", repositoryId: "repo-1", repositoryName: "acme/app", runNumber: 4, workflowName: "CI", event: "workflow_dispatch", branch: "main", commitSha: "0123456789abcdef", actorLogin: "octocat", status: "completed" as const, conclusion: "success" as const, queuedAt: "2026-08-11T10:00:00Z", startedAt: "2026-08-11T10:01:00Z", completedAt: "2026-08-11T10:02:00Z", durationMs: 60_000, runtimeBoundary: "Kata VM-backed container" as const };

describe("dashboard contracts", () => {
  test("parses valid overview, repository, run detail, and cursor page", () => {
    expect(OverviewDto.safeParse({ organizationId: "org-1", period: "24h", queued: 0, running: 1, completed: 2, failed: 0, queueP50Ms: 1, queueP95Ms: 2, durationP50Ms: 3, durationP95Ms: 4, concurrency: 1, utilization: { vcpu: .5, memory: .25, storage: 0, pods: 1 }, costSavings: { selfHostedMinutes: 4, pricedMinutes: 4, unpricedMinutes: 0, estimatedSavingsMicros: 40_000, currency: "USD", latestRateEffectiveFrom: "2026-01-01" }, timeseries: [{ bucket: "2026-08-11T10:00:00Z", pending: 0, running: 1 }] }).success).toBe(true);
    const legacyOverview = OverviewDto.safeParse({ organizationId: "org-1", period: "24h", queued: 0, running: 0, completed: 0, failed: 0, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 0, utilization: { vcpu: 0, memory: 0, storage: 0, pods: 0 } });
    expect(legacyOverview.success).toBe(false);
    expect(OverviewDto.safeParse({ organizationId: "org-1", period: "24h", queued: 0, running: 0, completed: 0, failed: 0, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 0, utilization: { vcpu: 0, memory: 0, storage: 0, pods: 0 }, costSavings: { selfHostedMinutes: 1, pricedMinutes: 0, unpricedMinutes: 0, estimatedSavingsMicros: 0, currency: "USD", latestRateEffectiveFrom: null } }).success).toBe(false);
    const repository = { id: "repo-1", organizationId: "org-1", name: "app", fullName: "acme/app", visibility: "private", available: true, installationId: "inst-1", discoveryState: "active" as const, discoveryRetryAt: null };
    expect(RepositorySummary.safeParse(repository).success).toBe(true);
    expect(RepositorySummary.safeParse({ ...repository, discoveryState: "paused", discoveryRetryAt: "2026-08-15T12:00:00.000Z" }).success).toBe(true);
    expect(RepositorySummary.safeParse({ ...repository, discoveryState: "queued" }).success).toBe(true);
    expect(RepositorySummary.safeParse({ ...repository, discoveryState: "blocked" }).success).toBe(false);
    expect(RepositorySummary.safeParse({ ...repository, approved: true }).success).toBe(false);
    expect(RepositorySummary.safeParse({ id: "repo-1", organizationId: "org-1", name: "app", fullName: "acme/app", private: true, installationId: "inst-1" }).success).toBe(false);
    expect(OnboardingStep.safeParse("resources").success).toBe(false);
    const detail = { ...run, jobs: [], stages: [{ stage: "queued" as const, startedAt: run.queuedAt, completedAt: run.startedAt, durationMs: 60_000 }], actionGraph: { nodes: [], edges: [] } };
    expect(RunDetail.safeParse(detail).success).toBe(true);
    expect(RunDetail.safeParse({ ...detail, stages: [{ ...detail.stages[0], startedAt: "bad" }] }).success).toBe(false);
  });
  test("enforces Cost Center row and headline invariants", () => {
    const priced = { organizationId: "org-1", repositoryId: "repo-1", repositoryName: "acme/app", platform: "windows-x64", requestedVcpu: 3, githubRunnerSku: "windows_4_core", githubRunnerVcpu: 4, jobCount: 2, selfHostedMinutes: 5, pricedMinutes: 5, unpricedMinutes: 0, estimatedSavingsMicros: 110_000 };
    const unmatched = { organizationId: "org-1", repositoryId: "repo-2", repositoryName: "acme/tools", platform: "linux-x64", requestedVcpu: 128, githubRunnerSku: null, githubRunnerVcpu: null, jobCount: 1, selfHostedMinutes: 2, pricedMinutes: 0, unpricedMinutes: 2, estimatedSavingsMicros: 0 };
    const payload = { organizationId: "org-1", period: "7d" as const, costSavings: { selfHostedMinutes: 7, pricedMinutes: 5, unpricedMinutes: 2, estimatedSavingsMicros: 110_000, currency: "USD" as const, latestRateEffectiveFrom: "2026-01-01" }, priceOverTime: [{ date: "2026-01-01", estimatedSavingsMicros: 110_000 }], breakdown: [priced, unmatched] };
    expect(CostCenterDto.safeParse(payload).success).toBe(true);
    expect(CostCenterDto.safeParse({ ...payload, costSavings: { ...payload.costSavings, pricedMinutes: 4 } }).success).toBe(false);
    expect(CostCenterDto.safeParse({ ...payload, breakdown: [{ ...priced, githubRunnerSku: null }] }).success).toBe(false);
    expect(CostCenterDto.safeParse({ ...payload, breakdown: [{ ...unmatched, estimatedSavingsMicros: 1 }, priced] }).success).toBe(false);
    expect(CostCenterPricingProvider.safeParse("azure-vm").success).toBe(true);
  });
  test("accepts applying worker configuration metadata", () => {
    expect(WorkerDetail.safeParse({
      id: "86afd915-add3-407c-a6c1-1b46803ef713",
      organizationId: null,
      name: "windows-worker",
      platform: "windows-x64",
      guestPlatforms: ["windows-x64"],
      driver: "windows-hyperv-container",
      selectedDriver: "windows-hyperv-container",
      admissionState: "adopted",
      connectionState: "online",
      configurationState: "applying",
      configurationRevision: "a".repeat(64),
      appliedConfigurationRevision: "b".repeat(64),
      configurationAppliedAt: "2026-08-16T15:00:00.000Z",
      lastHeartbeatAt: "2026-08-16T15:01:00.000Z",
      lastDoctorAt: "2026-08-16T15:01:00.000Z",
      runtimeMode: "container",
      artifactDigest: "sha256:" + "c".repeat(64),
      fingerprint: "sha256:worker",
      limits: null,
      doctor: null,
      capacity: {
        vcpu: { actual: 10, reserved: 0, free: 10 },
        memoryBytes: { actual: 10, reserved: 0, free: 10 },
        storageBytes: { actual: 10, reserved: 0, free: 10 },
        pods: { actual: 1, reserved: 0, free: 1 },
      },
      activeSandboxes: 0,
      draining: false,
    }).success).toBe(true);
  });
  test("accepts immutable VM template and OCI image digests", () => {
    const request = {
      workerId: "00000000-0000-4000-8000-000000000001",
      name: "default",
      guestPlatform: "windows-x64",
      resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 },
      triggerLabel: "mars-windows-x64",
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
