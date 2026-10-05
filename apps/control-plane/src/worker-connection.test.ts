import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { activateAuthenticatedWorkerConnection } from "./worker-connection.ts";

test("reconciles configuration before making a socket dispatchable", async () => {
  const order: string[] = [];
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const socket = { send: () => {}, close: () => {} };
  const workerSockets = new Map<string, typeof socket>();
  const db = preparedTestDatabase(name => {
    if (name === "worker_connection_heartbeat") order.push("heartbeat");
    if (name === "worker_connection_online") order.push("online");
    return [];
  });

  await activateAuthenticatedWorkerConnection({
    db,
    workerId,
    socket,
    workerSockets,
    reconcile: async () => { order.push("reconcile"); return { state: "applying", commandId: "command" }; },
    markAuthenticated: () => order.push("authenticated"),
    dispatcher: { register: () => order.push("register") },
  });

  expect(order).toEqual(["reconcile", "heartbeat", "authenticated", "register", "online"]);
  expect(workerSockets.get(workerId)).toBe(socket);
});

test("refreshes heartbeat for an already-enrolled worker on reconnect", async () => {
  const names: string[] = [];
  await activateAuthenticatedWorkerConnection({
    db: preparedTestDatabase(name => { names.push(name); return []; }),
    workerId: "worker",
    socket: { send: () => {}, close: () => {} },
    workerSockets: new Map(),
    reconcile: async () => ({ state: "ready", commandId: null }),
    markAuthenticated: () => {},
    dispatcher: { register: () => {} },
  });
  expect(names).toContain("worker_connection_heartbeat");
  expect(names).toContain("worker_connection_authenticate");
});

test("marks enrollment authenticated and clears the one-use hash atomically", async () => {
  const names: string[] = [];
  await activateAuthenticatedWorkerConnection({
    db: preparedTestDatabase(name => { names.push(name); return []; }),
    workerId: "worker",
    socket: { send: () => {}, close: () => {} },
    workerSockets: new Map(),
    reconcile: async () => ({ state: "ready", commandId: null }),
    markAuthenticated: () => {},
    dispatcher: { register: () => {} },
  });
  expect(names).toContain("worker_connection_authenticate");
});

test("does not expose a socket that closes while authentication is in flight", async () => {
  const socket = { send: () => {}, close: () => {} };
  const workerSockets = new Map<string, typeof socket>();
  let checks = 0;
  let registered = false;
  const activated = await activateAuthenticatedWorkerConnection({
    db: preparedTestDatabase(() => []),
    workerId: "worker",
    socket,
    workerSockets,
    reconcile: async () => ({ state: "ready", commandId: null }),
    isCurrent: () => ++checks === 1,
    markAuthenticated: () => {},
    dispatcher: { register: () => { registered = true; } },
  });
  expect(activated).toBe(false);
  expect(registered).toBe(false);
  expect(workerSockets.size).toBe(0);
});

test("does not expose a socket when reconciliation fails", async () => {
  const order: string[] = [];
  const workerSockets = new Map<string, { send: () => void; close: () => void }>();
  await expect(activateAuthenticatedWorkerConnection({
    db: preparedTestDatabase(() => { order.push("online"); return []; }),
    workerId: "worker",
    socket: { send: () => {}, close: () => {} },
    workerSockets,
    reconcile: async () => { order.push("reconcile"); throw new Error("invalid desired configuration"); },
    markAuthenticated: () => order.push("authenticated"),
    dispatcher: { register: () => order.push("register") },
  })).rejects.toThrow("invalid desired configuration");
  expect(order).toEqual(["reconcile"]);
  expect(workerSockets.size).toBe(0);
});
