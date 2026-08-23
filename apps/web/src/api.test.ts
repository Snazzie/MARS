import { expect, test } from "bun:test";
import { ApiRequestError, configureWorker, getWorkerCache, getWorkerHealth, getWorkers } from "./api.ts";
const workerHealth = {
  observedAt: "2026-08-23T12:00:00.000Z",
  connection: { state: "online", lastHeartbeatAt: "2026-08-23T11:59:59.000Z", lastDoctorAt: "2026-08-23T11:59:58.000Z", heartbeatAgeSeconds: 1, doctorAgeSeconds: 2 },
  usage: {
    cpu: { actual: 2, reserved: 1, free: 1 },
    memoryBytes: { actual: "100", reserved: "40", free: "60" },
    storageBytes: { actual: "1000", reserved: "400", free: "600" },
    pods: { actual: 2, reserved: 1, free: 1 },
  },
  cache: { desiredTtlSeconds: 3600, effectiveTtlSeconds: 3600, ready: true, generation: "11111111-1111-4111-8111-111111111111", sizeBytes: "20", entryCount: 2, observedAt: "2026-08-23T11:59:57.000Z", error: null },
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
