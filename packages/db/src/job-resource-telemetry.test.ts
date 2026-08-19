import { expect, test } from "bun:test";
import type { Sql } from "postgres";
import { persistJobResourceSample } from "./job-resource-telemetry.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const occurredAt = "2026-08-18T12:00:00.000Z";

function sampleEvent() {
  return {
    version: 1 as const,
    id: "44444444-4444-4444-8444-444444444444",
    workerId,
    type: "job.resource_sample",
    occurredAt,
    payload: { jobId, leaseId, occurredAt, cpuUsagePercent: 2, cpuTimeMs: 100, memoryWorkingSetBytes: 1024, memoryLimitBytes: 2048 },
  };
}

test("renews an active lease when a resource heartbeat is received", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("SELECT j.organization_id")) return [{ organizationId: "org", runId: "run" }];
    if (query.includes("INSERT INTO dashboard_job_resource_samples")) return [{ occurredAt }];
    return [];
  }) as unknown as Sql<{}>;

  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt))).resolves.toBe("stored");
  expect(queries.some(query => query.includes("UPDATE runner_leases SET expires_at"))).toBe(true);
});

test("does not renew a lease for a duplicate sample", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("SELECT j.organization_id")) return [{ organizationId: "org", runId: "run" }];
    return [];
  }) as unknown as Sql<{}>;

  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt))).resolves.toBe("duplicate");
  expect(queries.some(query => query.includes("UPDATE runner_leases SET expires_at"))).toBe(false);
});

test("stores delayed telemetry without extending the lease", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("SELECT j.organization_id")) return [{ organizationId: "org", runId: "run" }];
    if (query.includes("INSERT INTO dashboard_job_resource_samples")) return [{ occurredAt }];
    return [];
  }) as unknown as Sql<{}>;

  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse("2026-08-18T12:11:00.000Z"))).resolves.toBe("stored");
  expect(queries.some(query => query.includes("UPDATE runner_leases SET expires_at"))).toBe(false);
});
