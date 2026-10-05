import { expect, test } from "bun:test";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";
import { listJobResourceSamples, persistJobResourceSample } from "./job-resource-telemetry.ts";

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

function telemetryDb(state: string | null, insert: boolean) {
  let renewed = false;
  const db = preparedTestDatabase((name) => {
    if (name === "job_resource_telemetry_lease") return state ? [{ organizationId: "org", runId: "run", state }] : [];
    if (name === "job_resource_telemetry_insert") return insert ? [{ occurredAt }] : [];
    if (name === "job_resource_telemetry_renew") renewed = true;
    return [];
  });
  return { db, wasRenewed: () => renewed };
}

test("renews an active lease when a resource heartbeat is received", async () => {
  const { db, wasRenewed } = telemetryDb("online", true);
  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt))).resolves.toBe("stored");
  expect(wasRenewed()).toBe(true);
});

test("does not renew a lease for a duplicate sample", async () => {
  const { db, wasRenewed } = telemetryDb("online", false);
  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt))).resolves.toBe("duplicate");
  expect(wasRenewed()).toBe(false);
});

test("stores delayed telemetry without extending the lease", async () => {
  const { db, wasRenewed } = telemetryDb("online", true);
  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse("2026-08-18T12:11:00.000Z"))).resolves.toBe("stored");
  expect(wasRenewed()).toBe(false);
});

test("does not renew a lease outside the active online/busy states", async () => {
  const { db, wasRenewed } = telemetryDb("sandbox_ready", true);
  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt))).resolves.toBe("stored");
  expect(wasRenewed()).toBe(true);
});

test("acknowledges a late sample for a reaped lease without storing it", async () => {
  let inserted = false;
  const db = preparedTestDatabase((name) => {
    if (name === "job_resource_telemetry_lease") return [{ organizationId: "org", runId: "run", state: "reaped" }];
    if (name === "job_resource_telemetry_insert") inserted = true;
    return [];
  });
  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt))).resolves.toBe("ignored");
  expect(inserted).toBe(false);
});

test("acknowledges expired telemetry even when its lease is unknown", async () => {
  const { db } = telemetryDb(null, false);
  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt) + 24 * 60 * 60_000 + 1)).resolves.toBe("ignored");
});

test("rejects samples for an unknown lease", async () => {
  const { db } = telemetryDb(null, false);
  await expect(persistJobResourceSample(db, workerId, sampleEvent(), Date.parse(occurredAt))).resolves.toBe("rejected");
});

test("normalizes telemetry samples and returns a next cursor at the page boundary", async () => {
  const db = preparedTestDatabase((name) => name === "job_resource_telemetry_list" ? [
    { organizationId: "org", runId: "run", jobId, leaseId, occurredAt, cpuUsagePercent: "2.5", cpuTimeMs: "100", memoryWorkingSetBytes: "1024", memoryLimitBytes: "2048", diskUsageBytes: null },
    { organizationId: "org", runId: "run", jobId, leaseId, occurredAt: "2026-08-18T12:00:01.000Z", cpuUsagePercent: "3", cpuTimeMs: "200", memoryWorkingSetBytes: "2048", memoryLimitBytes: "4096", diskUsageBytes: "512" },
  ] : []);
  const result = await listJobResourceSamples(db, "org", "run", jobId, null, 1);
  expect(result.items).toEqual([expect.objectContaining({ cpuUsagePercent: 2.5, cpuTimeMs: 100, memoryWorkingSetBytes: 1024, memoryLimitBytes: 2048, diskUsageBytes: null })]);
  expect(result.nextCursor).toBe(occurredAt);
});
