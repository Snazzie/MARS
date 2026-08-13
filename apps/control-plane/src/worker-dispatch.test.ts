import { describe, expect, test } from "bun:test";
import { WorkerCommandDispatcher } from "./worker-dispatch.ts";
import type { WorkerCommand } from "@whitesmith/contracts";

const workerId = "00000000-0000-4000-8000-000000000001";
const command: WorkerCommand = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000002",
  type: "doctor",
  workerId,
  leaseId: null,
  occurredAt: new Date().toISOString(),
  payload: {},
};

describe("WorkerCommandDispatcher registration", () => {
  test("does not replay twice when the same socket registers repeatedly", async () => {
    const sent: string[] = [];
    const store = {
      async save() {},
      async listUnacknowledged() { return [command]; },
      async markSent() {},
      async acknowledge() {},
    };
    const socket = { send(data: string) { sent.push(data); } };
    const dispatcher = new WorkerCommandDispatcher(100, store);

    dispatcher.register(workerId, socket);
    dispatcher.register(workerId, socket);
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).id).toBe(command.id);
  });
});

test("replays a command committed after socket authentication", async () => {
  const sent: string[] = [];
  let commands: WorkerCommand[] = [];
  const store = {
    async save() {},
    async listUnacknowledged() { return commands; },
    async markSent() {},
    async acknowledge() {},
  };
  const socket = { send(data: string) { sent.push(data); } };
  const dispatcher = new WorkerCommandDispatcher(100, store);
  dispatcher.register(workerId, socket);
  await Promise.resolve();
  commands = [{ ...command, id: "00000000-0000-4000-8000-000000000004" }];
  await dispatcher.replayConnected(workerId);
  expect(sent.map(data => JSON.parse(data).id)).toContain(commands[0]!.id);
});

test("accepts the first acknowledgement for a newly persisted command", async () => {
  const sent: string[] = [];
  const acknowledged: string[] = [];
  const store = {
    async save() {},
    async listUnacknowledged() { return []; },
    async markSent() {},
    async acknowledge(id: string) { acknowledged.push(id); },
  };
  const socket = { send(data: string) { sent.push(data); } };
  const dispatcher = new WorkerCommandDispatcher(100, store);
  dispatcher.register(workerId, socket);
  await Promise.resolve();
  await dispatcher.dispatch({ type: "doctor", workerId, leaseId: null, payload: {} });
  const dispatched = JSON.parse(sent[0]!);
  expect(dispatcher.handleEvent({ version: 1, id: crypto.randomUUID(), workerId, type: "command.accepted", occurredAt: new Date().toISOString(), payload: { commandId: dispatched.id, leaseId: null } }, socket)).toBe(true);
  await Promise.resolve();
  expect(acknowledged).toEqual([dispatched.id]);
});

test("replays terminal-lease stop commands until their cleanup event is acknowledged", async () => {
  const modulePath = "./worker-dispatch.ts";
  const module = await import(modulePath) as typeof import("./worker-dispatch.ts") & {
    listReplayableWorkerCommands?: (db: unknown, workerId: string) => Promise<WorkerCommand[]>;
  };
  expect(module.listReplayableWorkerCommands).toBeFunction();
  if (!module.listReplayableWorkerCommands) return;
  const queries: string[] = [];
  const stopCommand = { ...command, type: "tart.stop_lease", leaseId: "22222222-2222-4222-8222-222222222222", occurredAt: new Date() };
  const db = Object.assign(async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [stopCommand];
  }, {});
  const result = await module.listReplayableWorkerCommands(db, workerId);
  expect(queries[0]).toContain("c.type='tart.stop_lease'");
  expect(result).toEqual([{ ...stopCommand, occurredAt: stopCommand.occurredAt.toISOString() }]);
});

describe("WorkerCommandDispatcher frame and payload hardening", () => {
  test("rejects events from a superseded socket", async () => {
    let commandId = "";
    const first = { send(data: string) { commandId = JSON.parse(data).id; }, close() {} };
    const second = { send() {}, close() {} };
    const dispatcher = new WorkerCommandDispatcher(1000);
    dispatcher.register(workerId, first);
    const result = dispatcher.dispatch({ type: "doctor", workerId, leaseId: null, payload: {} });
    await Promise.resolve();
    dispatcher.register(workerId, second);
    const event = {
      version: 1 as const,
      id: "00000000-0000-4000-8000-000000000003",
      workerId,
      type: "ack",
      occurredAt: new Date().toISOString(),
      payload: { commandId },
    };
    expect(dispatcher.handleEvent(event, first)).toBe(false);
    result.catch(() => {});
  });

  test("rejects normalized secret-key variants before sending", async () => {
    for (const key of ["encodedJitConfig", "GITHUB_TOKEN", "job_claim", "private_key"]) {
      const sent: string[] = [];
      const socket = { send(data: string) { sent.push(data); } };
      const dispatcher = new WorkerCommandDispatcher(100);
      dispatcher.register(workerId, socket);
      await expect(dispatcher.dispatch({ type: "doctor", workerId, leaseId: null, payload: { [key]: "sensitive" } })).rejects.toThrow("secret material");
      expect(sent).toHaveLength(0);
    }
  });
});
