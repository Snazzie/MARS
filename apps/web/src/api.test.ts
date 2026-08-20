import { expect, test } from "bun:test";
import { ApiRequestError, configureWorker, getWorkers } from "./api.ts";
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
