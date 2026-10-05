import { expect, test } from "bun:test";
import { createControlPlaneGateway, enqueueWorkerMessage, scheduleWorkerHeartbeatDeadline, scheduleWorkerPing, sendWorkerAuthenticationFrames, sendWorkerStatus } from "./control-plane-gateway.ts";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";

test("schedules worker heartbeat pings without sending immediately", () => {
  let sendCount = 0;
  let capturedCallback!: () => void;
  let capturedDelay = 0;
  scheduleWorkerPing(
    () => { sendCount += 1; },
    (callback, delayMs) => {
      capturedCallback = callback;
      capturedDelay = delayMs;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  );
  expect(sendCount).toBe(0);
  expect(capturedDelay).toBe(10_000);
  capturedCallback();
  expect(sendCount).toBe(1);
});
test("expires an unanswered worker heartbeat at the application deadline", () => {
  let expire!: () => void;
  let delay = 0;
  let expired = false;
  scheduleWorkerHeartbeatDeadline(
    () => { expired = true; },
    (callback, delayMs) => {
      expire = callback;
      delay = delayMs;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  );
  expect(delay).toBe(30_000);
  expect(expired).toBe(false);
  expire();
  expect(expired).toBe(true);
});


test("sends authenticated and ping frames before durable replay", async () => {
  const order: string[] = [];
  const sent: string[] = [];
  await sendWorkerAuthenticationFrames({
    socket: { send(data: string) { sent.push(data); order.push(JSON.parse(data).type); } },
    workerId: "worker",
    admissionState: "adopted",
    dispatcher: {
      async replayConnected() {
        order.push("replay");
      },
    },
  });
  expect(order).toEqual(["authenticated", "ping", "replay"]);
  expect(JSON.parse(sent[0]!).admissionState).toBe("adopted");
});
test("broadcasts worker status frames only to browser sockets", () => {
  const sent: string[] = [];
  sendWorkerStatus([
    { data: { actor: "browser", organizationId: "all", cursor: 0 }, send: data => sent.push(String(data)) },
    { data: { actor: "worker", workerId: "worker", authenticated: true }, send: data => sent.push(String(data)) },
  ], "worker", "online");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toMatchObject({ version: 1, type: "worker_status", state: "online" });
});




test("serializes worker frames on one socket", async () => {
  const tails = new WeakMap<object, Promise<void>>();
  const socket = {};
  const order: string[] = [];
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const firstRun = enqueueWorkerMessage(tails, socket, async () => {
    order.push("begin");
    markStarted();
    await first;
    order.push("begin-done");
  });
  const secondRun = enqueueWorkerMessage(tails, socket, async () => {
    order.push("end");
  });

  await started;
  expect(order).toEqual(["begin"]);
  releaseFirst();
  await Promise.all([firstRun, secondRun]);
  expect(order).toEqual(["begin", "begin-done", "end"]);
});

test("records the rejected worker frame and disconnect context without logging frame contents", async () => {
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => errors.push(args);
  console.warn = (...args) => warnings.push(args);
  try {
    const gateway = createControlPlaneGateway({
      db: preparedTestDatabase(() => []),
      httpFetch: async () => new Response(),
      current: async () => null,
      requestSource: () => "test",
      dispatcher: { unregister() {} } as never,
      triggerReconciliation: async () => {},
      refreshDefaultPools: async () => {},
      requestId: () => crypto.randomUUID(),
    });
    const closed: unknown[][] = [];
    const socket = {
      data: { actor: "worker", workerId: crypto.randomUUID(), connectionEpoch: 7, authenticated: false },
      close: (...args: unknown[]) => closed.push(args),
    } as never;
    await gateway.websocket.message?.(socket, "{secret: do-not-log}");
    expect(closed).toEqual([[1008, "invalid worker frame"]]);
    expect(errors[0]?.[0]).toBe("Worker websocket frame failed");
    expect(errors[0]?.[1]).toMatchObject({ connectionEpoch: 7, frameType: "unknown" });
    expect(JSON.stringify(errors)).not.toContain("do-not-log");
    gateway.websocket.close?.(socket, 1008, "invalid worker frame");
    expect(warnings[0]?.[1]).toMatchObject({ connectionEpoch: 7, authenticated: false, current: false, code: 1008, reason: "invalid worker frame" });
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});
