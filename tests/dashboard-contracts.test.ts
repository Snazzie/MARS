import { describe, expect, test } from "bun:test";
import { ApiError, CursorPage, OverviewDto, RepositorySummary, RunDetail } from "../packages/contracts/src/index.ts";

const resources = { vcpu: 2, memoryBytes: 4_000_000_000, storageBytes: 20_000_000_000, concurrency: 1 };
const run = { id: "run-1", organizationId: "org-1", repositoryId: "repo-1", repositoryName: "acme/app", runNumber: 4, workflowName: "CI", status: "completed" as const, conclusion: "success" as const, queuedAt: "2026-08-11T10:00:00Z", startedAt: "2026-08-11T10:01:00Z", completedAt: "2026-08-11T10:02:00Z" };

describe("dashboard contracts", () => {
  test("parses valid overview, repository, run detail, and cursor page", () => {
    expect(OverviewDto.safeParse({ organizationId: "org-1", period: "24h", queued: 0, running: 1, completed: 2, failed: 0, queueP50Ms: 1, queueP95Ms: 2, durationP50Ms: 3, durationP95Ms: 4, concurrency: 1, utilization: { vcpu: .5, memory: .25, storage: 0, pods: 1 } }).success).toBe(true);
    expect(RepositorySummary.safeParse({ id: "repo-1", organizationId: "org-1", name: "app", fullName: "acme/app", private: true, installationId: "inst-1", approved: true }).success).toBe(true);
    const detail = { ...run, jobs: [], actionGraph: { nodes: [], edges: [] } };
    expect(RunDetail.safeParse(detail).success).toBe(true);
    expect(CursorPage(RunDetail).safeParse({ items: [detail], nextCursor: "Y3Vyc29y" }).success).toBe(true);
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
