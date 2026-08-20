import { expect, test } from "bun:test";
import { ApiRequestError, getWorkers } from "./api.ts";
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
