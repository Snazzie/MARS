import { describe, expect, test } from "bun:test";
import { WorkerCommandDispatcher, WorkerDispatchError } from "../apps/control-plane/src/worker-dispatch.ts";
const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const event = (commandId: string) => ({ version: 1, id: "33333333-3333-4333-8333-333333333333", workerId, type: "sandbox_attested", occurredAt: new Date().toISOString(), payload: { commandId, leaseId } });
describe("worker command dispatch", () => {
  test("rejects unauthenticated worker and generates validated envelope", async () => { const dispatcher = new WorkerCommandDispatcher(); await expect(dispatcher.dispatch({ workerId, type: "tart.create_lease", leaseId, payload: {} })).rejects.toBeInstanceOf(WorkerDispatchError); let sent = ""; dispatcher.register(workerId, { send: value => { sent = value; } }); const pending = dispatcher.dispatch({ workerId, type: "tart.create_lease", leaseId, payload: {} }); const command = JSON.parse(sent); expect(command).toMatchObject({ version: 1, workerId, leaseId, type: "tart.create_lease" }); expect(command.id).toMatch(/[0-9a-f-]{36}/); dispatcher.handleEvent(event(command.id)); await expect(pending).resolves.toMatchObject({ type: "sandbox_attested" }); });
  test("correlates by lease and fails on disconnect or timeout", async () => { let sent = ""; const dispatcher = new WorkerCommandDispatcher(5); dispatcher.register(workerId, { send: value => { sent = value; } }); const timed = dispatcher.dispatch({ workerId, type: "tart.stop_lease", leaseId, payload: {} }); await expect(timed).rejects.toThrow("timed out"); const disconnected = new WorkerCommandDispatcher(); disconnected.register(workerId, { send: () => {} }); const pending = disconnected.dispatch({ workerId, type: "tart.stop_lease", leaseId, payload: {} }); disconnected.unregister(workerId); await expect(pending).rejects.toThrow("disconnected"); });
  test("does not serialize plaintext secret-like fields", () => { const dispatcher = new WorkerCommandDispatcher(); let sent = ""; dispatcher.register(workerId, { send: value => { sent = value; } }); void dispatcher.dispatch({ workerId, type: "tart.create_lease", leaseId, payload: { imageDigest: "sha256:abc" } }); expect(sent).not.toContain("encoded_jit_config"); expect(sent).not.toContain("enrollment"); });
  test("serializes replay and dispatch without duplicate sends", async () => {
    let release!: () => void; const listed = new Promise<void>(resolve => { release = resolve; }); const sent: string[] = [];
    const store = { save: async () => {}, listUnacknowledged: async () => { await listed; return []; }, markSent: async () => {}, acknowledge: async () => {} };
    const socket = { send: (value: string) => sent.push(value) }; const dispatcher = new WorkerCommandDispatcher(1000, store);
    dispatcher.register(workerId, socket); const pending = dispatcher.dispatch({ workerId, type: "tart.create_lease", leaseId, payload: {} });
    await Promise.resolve(); expect(sent).toHaveLength(0); release(); for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(sent).toHaveLength(1); const command = JSON.parse(sent[0]!); dispatcher.handleEvent(event(command.id), socket); await expect(pending).resolves.toMatchObject({ type: "sandbox_attested" });
  });
  test("superseding a socket closes and revokes the stale socket", () => {
    const first = { send: () => {}, close: () => {} }; const second = { send: () => {} }; const dispatcher = new WorkerCommandDispatcher();
    dispatcher.register(workerId, first); dispatcher.register(workerId, second); expect(dispatcher.handleEvent(event("missing"), first)).toBe(false);
  });
  test("acknowledges replayed durable commands without an in-memory waiter", async () => {
    const command = { version: 1, id: "44444444-4444-4444-8444-444444444444", workerId, type: "tart.stop_lease", leaseId, occurredAt: new Date().toISOString(), payload: {} };
    let acknowledged = "";
    const store = { save: async () => {}, listUnacknowledged: async () => [command], markSent: async () => {}, acknowledge: async (id: string) => { acknowledged = id; } };
    const socket = { send: () => {} };
    const dispatcher = new WorkerCommandDispatcher(1000, store);
    dispatcher.register(workerId, socket);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(dispatcher.handleEvent(event(command.id), socket)).toBe(true);
    await Promise.resolve();
    expect(acknowledged).toBe(command.id);
    expect(dispatcher.handleEvent(event(command.id), socket)).toBe(false);
  });
});
