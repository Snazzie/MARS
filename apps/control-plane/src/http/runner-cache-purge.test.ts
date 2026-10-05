import { preparedTestDatabase } from "../../../../packages/db/src/prepared-test-fixture.ts";
import { expect, test } from "bun:test";
import { createControlPlaneApp } from "./app.ts";
import { fakeHttpDeps } from "./test-deps.ts";
import { WorkerCommandDispatcher } from "../worker-dispatch.ts";

const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
function purgeDb() {
  const db = preparedTestDatabase(name => {
    if (name === "route_purge_worker" || name === "worker_request_cache_worker_lock") return [{ id: workerId, admissionState: "adopted" }];
    return [];
  });
  return { db };
}

test("runner cache purge requires an authenticated global administrator", async () => {
  const { db } = purgeDb();
  const app = createControlPlaneApp(fakeHttpDeps({ db: db as never, workerDispatcher: new WorkerCommandDispatcher() }));
  const response = await app.request(`/api/workers/${workerId}/cache/purge`, { method: "POST", headers: { "Idempotency-Key": "purge-once" } });
  expect(response.status).toBe(401);
});

test("authenticated global administrator receives an accepted purge command", async () => {
  const { db } = purgeDb();
  const app = createControlPlaneApp(fakeHttpDeps({
    db: db as never,
    workerDispatcher: new WorkerCommandDispatcher(),
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  }));
  const response = await app.request(`/api/workers/${workerId}/cache/purge`, { method: "POST", headers: { "Idempotency-Key": "purge-once" } });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ workerId, commandId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
});
