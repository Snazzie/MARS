import { expect, test } from "bun:test";
import { activateAuthenticatedWorkerConnection } from "./worker-connection.ts";

test("reconciles configuration before making a socket dispatchable", async () => {
  const order: string[] = [];
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const socket = { send: () => {}, close: () => {} };
  const workerSockets = new Map<string, typeof socket>();
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("last_heartbeat_at=now()")) order.push("heartbeat");
    if (query.includes("connection_state='online'")) order.push("online");
    return [];
  }) as never;

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
  const queries: string[] = [];
  let enrollmentUpdateSkipped = false;
  await activateAuthenticatedWorkerConnection({
    db: (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("enrollment_authenticated_at is null")) enrollmentUpdateSkipped = true;
      return [];
    }) as never,
    workerId: "worker",
    socket: { send: () => {}, close: () => {} },
    workerSockets: new Map(),
    reconcile: async () => ({ state: "ready", commandId: null }),
    markAuthenticated: () => {},
    dispatcher: { register: () => {} },
  });
  expect(enrollmentUpdateSkipped).toBe(true);
  expect(queries.some(query => query.includes("set last_heartbeat_at=now()"))).toBe(true);
});

test("marks enrollment authenticated and clears the one-use hash atomically", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [];
  }) as never;
  await activateAuthenticatedWorkerConnection({
    db,
    workerId: "worker",
    socket: { send: () => {}, close: () => {} },
    workerSockets: new Map(),
    reconcile: async () => ({ state: "ready", commandId: null }),
    markAuthenticated: () => {},
    dispatcher: { register: () => {} },
  });
  expect(queries.some(query => query.includes("enrollment_authenticated_at=now()") && query.includes("enrollment_code_hash=null"))).toBe(true);
});

test("does not expose a socket that closes while authentication is in flight", async () => {
  const socket = { send: () => {}, close: () => {} };
  const workerSockets = new Map<string, typeof socket>();
  let checks = 0;
  let registered = false;
  const activated = await activateAuthenticatedWorkerConnection({
    db: (async () => []) as never,
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
    db: (async () => { order.push("online"); return []; }) as never,
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
