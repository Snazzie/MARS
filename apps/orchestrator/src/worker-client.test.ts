import { expect, test } from "bun:test";
import { retryControlPlaneOperation, waitForWorkerSocketClose, WorkerEventTransport } from "./worker-client.ts";

test("reconnects when a worker websocket errors without closing", async () => {
  class FaultingSocket extends EventTarget {
    closeCalls = 0;
    close(): void { this.closeCalls += 1; }
  }
  const socket = new FaultingSocket();
  const closed = waitForWorkerSocketClose(socket as unknown as WebSocket);
  socket.dispatchEvent(new Event("error"));
  await closed;
  expect(socket.closeCalls).toBe(1);
});
test("keeps an opened worker websocket alive past its connection deadline", async () => {
  class OpenSocket extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    closeCalls = 0;
    close(): void { this.closeCalls += 1; this.dispatchEvent(new Event("close")); }
  }
  const socket = new OpenSocket();
  let timeout!: () => void;
  let cancelled = false;
  const closed = waitForWorkerSocketClose(
    socket as unknown as WebSocket,
    10,
    callback => { timeout = () => { if (!cancelled) callback(); }; return 1 as unknown as ReturnType<typeof setTimeout>; },
    () => { cancelled = true; },
  );
  socket.readyState = WebSocket.OPEN;
  socket.dispatchEvent(new Event("open"));
  expect(cancelled).toBe(true);
  timeout();
  expect(socket.closeCalls).toBe(0);
  socket.close();
  await closed;
});
test("reconnects an open worker socket after control-plane pings stop", async () => {
  class SilentSocket extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    closeCalls = 0;
    close(): void { this.closeCalls += 1; this.dispatchEvent(new Event("close")); }
  }
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let nextId = 0;
  const socket = new SilentSocket();
  const closed = waitForWorkerSocketClose(
    socket as unknown as WebSocket,
    30_000,
    (callback, delay) => { const id = ++nextId; delays.push(delay); timers.set(id, callback); return id as never; },
    handle => { timers.delete(handle as unknown as number); },
    60_000,
  );
  socket.readyState = WebSocket.OPEN;
  socket.dispatchEvent(new Event("open"));
  expect(delays).toEqual([30_000, 60_000]);
  const firstDeadline = nextId;
  socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"ping"}' }));
  expect(timers.has(firstDeadline)).toBe(false);
  expect(delays).toEqual([30_000, 60_000, 60_000]);
  timers.get(nextId)!();
  await closed;
  expect(socket.closeCalls).toBe(1);
  expect(timers.size).toBe(0);
});


test("retains worker events until the control plane acknowledges them", () => {
  class RecordingSocket extends EventTarget {
    readyState = WebSocket.OPEN;
    sent: string[] = [];
    send(value: string): void { this.sent.push(value); }
  }
  const transport = new WorkerEventTransport();
  const first = new RecordingSocket();
  const second = new RecordingSocket();
  const event = { version: 1 as const, id: crypto.randomUUID(), workerId: crypto.randomUUID(), type: "runner.finished", occurredAt: new Date().toISOString(), payload: {} };
  transport.bind(first as unknown as WebSocket);
  transport.send(event);
  transport.unbind(first as unknown as WebSocket);
  transport.bind(second as unknown as WebSocket);
  expect(first.sent).toHaveLength(1);
  expect(second.sent).toEqual([JSON.stringify(event)]);
  transport.acknowledge(event.id);
  transport.unbind(second as unknown as WebSocket);
  const third = new RecordingSocket();
  transport.bind(third as unknown as WebSocket);
  expect(third.sent).toEqual([]);
});
test("drops unacknowledged cache frames while disabled without losing other events", () => {
  let enabled = true;
  const transport = new WorkerEventTransport(() => enabled);
  const sent: string[] = [];
  const socket = { readyState: WebSocket.OPEN, send(value: string) { sent.push(value); } } as WebSocket;
  const workerId = crypto.randomUUID();
  const make = (type: string) => ({ version: 1 as const, id: crypto.randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload: {} });
  transport.bind(socket);
  transport.send(make("worker.cache_snapshot_begin"));
  transport.send(make("runner.finished"));
  transport.unbind(socket);
  enabled = false;
  const reconnect = { readyState: WebSocket.OPEN, send(value: string) { sent.push(value); } } as WebSocket;
  transport.bind(reconnect);
  transport.send(make("worker.runner_cache_status"));
  expect(sent.map(value => JSON.parse(value).type)).toEqual(["worker.cache_snapshot_begin", "runner.finished", "runner.finished"]);
  enabled = true;
  transport.unbind(reconnect);
  const afterEnable: string[] = [];
  transport.bind({ readyState: WebSocket.OPEN, send(value: string) { afterEnable.push(value); } } as WebSocket);
  expect(afterEnable.map(value => JSON.parse(value).type)).toEqual(["runner.finished"]);
});

test("retries transient control-plane failures until the operation succeeds", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await retryControlPlaneOperation(
    "test operation",
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("connection refused") as Error & { code: string };
        error.code = "ECONNREFUSED";
        throw error;
      }
      return "ready";
    },
    async (milliseconds) => { sleeps.push(milliseconds); },
  );

  expect(result).toBe("ready");
  expect(attempts).toBe(3);
  expect(sleeps).toEqual([1_000, 1_000]);
});
test("retries transient control-plane HTTP responses", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const response = await retryControlPlaneOperation(
    "test operation",
    async () => new Response(null, { status: ++attempts === 1 ? 503 : 204 }),
    async milliseconds => { sleeps.push(milliseconds); },
  );
  expect(response.status).toBe(204);
  expect(attempts).toBe(2);
  expect(sleeps).toEqual([1_000]);
});

test("does not sleep after an immediately successful control-plane operation", async () => {
  const sleeps: number[] = [];
  await expect(retryControlPlaneOperation("test operation", async () => 42, async (milliseconds) => { sleeps.push(milliseconds); })).resolves.toBe(42);
  expect(sleeps).toEqual([]);
});
