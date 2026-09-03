import { expect, test } from "bun:test";
import { ApiRequestError, configureWorker, getJobResourceSamples, getWorkerCache, getWorkerHealth, getWorkers, purgeWorkerCache } from "./api.ts";
import type { WorkerHealth } from "@mars/contracts";
const workerHealth: WorkerHealth = {
  observedAt: "2026-08-23T12:00:00.000Z",
  connection: { state: "online", lastHeartbeatAt: "2026-08-23T11:59:59.000Z", lastDoctorAt: "2026-08-23T11:59:58.000Z", heartbeatAgeSeconds: 1, doctorAgeSeconds: 2 },
  usage: {
    cpu: { actual: 2, reserved: 1, free: 1 },
    memoryBytes: { actual: "100", reserved: "40", free: "60" },
    storageBytes: { actual: "1000", reserved: "400", free: "600" },
    pods: { actual: 2, reserved: 1, free: 1 },
  },
  cache: { desiredTtlSeconds: 3600, effectiveTtlSeconds: 3600, effectiveRunnerCacheEnabled: true, effectiveRunnerCacheMaxGiB: 20, ready: true, generation: "11111111-1111-4111-8111-111111111111", sizeBytes: "20", entryCount: 2, runnerCacheSizeBytes: "30", runnerCacheEntryCount: 3, observedAt: "2026-08-23T11:59:57.000Z", runnerCacheObservedAt: "2026-08-23T11:59:56.000Z", error: null },
  containers: [{
    containerId: "a".repeat(64),
    name: "managed",
    leaseId: "22222222-2222-4222-8222-222222222222",
    state: "running",
    cpuUsagePercent: 6.5,
    memoryWorkingSetBytes: "40",
    memoryLimitBytes: "80",
    diskUsageBytes: "100",
    sampledAt: "2026-08-23T11:59:55.000Z",
  }],
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
};
test("loads worker health from the no-store endpoint and parses its contract", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  let cache: RequestCache | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input);
    cache = init?.cache;
    return new Response(JSON.stringify(workerHealth), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await getWorkerHealth("worker-1");
    expect(requested).toBe("/api/workers/worker-1/health");
    expect(cache).toBe("no-store");
    expect(result).toMatchObject({ connection: { state: "online" }, cache: { generation: "11111111-1111-4111-8111-111111111111" } });
    expect(result.containers).toEqual(workerHealth.containers);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("rejects worker health containers with unknown fields", async () => {
  const originalFetch = globalThis.fetch;
  const malformed = {
    ...workerHealth,
    containers: [{ ...workerHealth.containers[0], unexpected: true }],
  };
  globalThis.fetch = (async () => new Response(JSON.stringify(malformed), { status: 200 })) as unknown as typeof fetch;
  try {
    await getWorkerHealth("worker-1");
    throw new Error("expected getWorkerHealth to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 200, code: "invalid_response" });
    expect((error as ApiRequestError).message).toContain("containers.0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("reports the worker health endpoint when its contract response is malformed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  try {
    await getWorkerHealth("worker-1");
    throw new Error("expected getWorkerHealth to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 200, code: "invalid_response" });
    expect((error as ApiRequestError).message).toContain("GET /api/workers/worker-1/health");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves API errors from the worker health endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "worker_unavailable", message: "Worker health unavailable", requestId: "request-1" }), { status: 503 })) as unknown as typeof fetch;
  try {
    await getWorkerHealth("worker-1");
    throw new Error("expected getWorkerHealth to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 503, code: "worker_unavailable", message: "Worker health unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("reports the endpoint and contract path for malformed responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [{}], nextCursor: null }), { status: 200 })) as unknown as typeof fetch;
  try {
    await getWorkers("org-1");
    throw new Error("expected getWorkers to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    const requestError = error as ApiRequestError;
    expect(requestError.code).toBe("invalid_response");
    expect(requestError.status).toBe(200);
    expect(requestError.message).toContain("GET /api/organizations/org-1/workers?includeInactive=false: items.0.id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("sends worker configuration as a POST request", async () => {
  const originalFetch = globalThis.fetch;
  let method = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    method = init?.method ?? "GET";
    return new Response(JSON.stringify({ revision: "a".repeat(64), fingerprint: "b".repeat(64), commandId: "00000000-0000-4000-8000-000000000001" }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await configureWorker("worker-1", {
      appliance: { vcpu: 1, memoryBytes: 1024 ** 3, storageBytes: 1024 ** 3 },
      runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1024 ** 3, maxStorageBytesPerPod: 1024 ** 3, maxConcurrentPods: 1 },
      guestPlatforms: ["linux-x64"],
    });
    expect(method).toBe("POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loads a worker cache inventory page with cursor, limit, and search", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await getWorkerCache("worker-1", { cursor: "next_page", query: "Acme", limit: 25 });
    expect(requested).toBe("/api/workers/worker-1/cache?cursor=next_page&limit=25&query=Acme");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("purges a worker runner cache through the authenticated endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  let method = "";
  let idempotencyKey = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input);
    method = init?.method ?? "GET";
    idempotencyKey = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    return new Response(JSON.stringify({ workerId: "worker-1", commandId: "00000000-0000-4000-8000-000000000001" }), { status: 202, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    await expect(purgeWorkerCache("worker-1")).resolves.toEqual({ workerId: "worker-1", commandId: "00000000-0000-4000-8000-000000000001" });
    expect(requested).toBe("/api/workers/worker-1/cache/purge");
    expect(method).toBe("POST");
    expect(idempotencyKey).not.toBe("");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("loads job resource samples with organization, run, job, cursor, and limit", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await getJobResourceSamples("org-1", "run-1", "job-1", "next_page", 100);
    expect(requested).toBe("/api/organizations/org-1/runs/run-1/jobs/job-1/resource-samples?limit=100&after=next_page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
