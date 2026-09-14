import { expect, test } from "bun:test";
import { createControlPlaneApp } from "./app.ts";
import { fakeHttpDeps } from "./test-deps.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const admin = { id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true };
const member = { ...admin, id: "member", login: "member", isGlobalAdmin: false };

const workerDb = Object.assign(async (strings: TemplateStringsArray) => strings.join(" ").includes("SELECT id FROM workers") ? [{ id: workerId }] : [], {}) as never;

test("control-plane logs require global administrator access and preserve filters", async () => {
  const source = {
    list(input: unknown) {
      expect(input).toEqual({ after: 4, limit: 25, level: "error", contains: workerId });
      return { items: [{ sequence: 5, occurredAt: "2026-09-14T20:00:00.000Z", level: "error" as const, message: `worker ${workerId} failed` }], nextCursor: 5 };
    },
  };
  const denied = createControlPlaneApp(fakeHttpDeps({ currentUser: async () => member, controlPlaneLogs: source })).request("/api/admin/logs", { headers: { Cookie: "mars_session=test" } });
  expect((await denied).status).toBe(403);

  const response = await createControlPlaneApp(fakeHttpDeps({ currentUser: async () => admin, controlPlaneLogs: source })).request(`/api/admin/logs?after=4&limit=25&level=error&contains=${workerId}`, { headers: { Cookie: "mars_session=test" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ items: [{ sequence: 5, level: "error" }], nextCursor: 5 });
});

test("worker logs request a bounded live snapshot from the authenticated worker", async () => {
  const dispatcher = {
    async request(input: Record<string, unknown>) {
      const payload = input.payload as { requestId: string; maxBytes: number };
      expect(input).toMatchObject({ workerId, type: "worker.collect_logs", leaseId: null });
      expect(payload.maxBytes).toBe(4096);
      return {
        version: 1 as const,
        id: crypto.randomUUID(),
        workerId,
        type: "worker.logs",
        occurredAt: new Date().toISOString(),
        payload: { commandId: crypto.randomUUID(), requestId: payload.requestId, observedAt: "2026-09-14T20:00:00.000Z", content: "Mac worker command failed" },
      };
    },
  };
  const response = await createControlPlaneApp(fakeHttpDeps({ db: workerDb, currentUser: async () => admin, workerDispatcher: dispatcher as never })).request(`/api/workers/${workerId}/logs?maxBytes=4096`, { headers: { Cookie: "mars_session=test" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ workerId, content: "Mac worker command failed" });
});
