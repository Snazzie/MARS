import { expect, test } from "bun:test";
import { createControlPlaneApp } from "./app.ts";
import { fakeHttpDeps } from "./test-deps.ts";
import { WorkerCommandDispatcher } from "../worker-dispatch.ts";

type FakeQuery = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  begin<T>(fn: (tx: FakeQuery) => Promise<T>): Promise<T>;
};

const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
function purgeDb() {
  const queries: string[] = [];
  const query = (async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    queries.push(text);
    if (text.includes("SELECT id,admission_state") || text.includes("select id,admission_state")) return [{ id: workerId, admissionState: "adopted" }];
    if (text.includes("select response from worker_mutations")) return [];
    return [];
  }) as FakeQuery;
  query.begin = async <T>(fn: (tx: FakeQuery) => Promise<T>) => fn(query);
  return { db: query, queries };
}

test("runner cache purge requires an authenticated global administrator", async () => {
  const { db } = purgeDb();
  const app = createControlPlaneApp(fakeHttpDeps({ db: db as never, workerDispatcher: new WorkerCommandDispatcher() }));
  const response = await app.request(`/api/workers/${workerId}/cache/purge`, { method: "POST", headers: { "Idempotency-Key": "purge-once" } });
  expect(response.status).toBe(401);
});

test("runner cache purge persists and dispatches a no-lease worker command", async () => {
  const { db, queries } = purgeDb();
  const app = createControlPlaneApp(fakeHttpDeps({
    db: db as never,
    workerDispatcher: new WorkerCommandDispatcher(),
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  }));
  const response = await app.request(`/api/workers/${workerId}/cache/purge`, { method: "POST", headers: { "Idempotency-Key": "purge-once" } });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ workerId });
  expect(queries.some(query => query.includes("worker.runner_cache_purge"))).toBe(true);
  expect(queries.some(query => query.includes("worker.runner_cache_purge_requested"))).toBe(true);
});
