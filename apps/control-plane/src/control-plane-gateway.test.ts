import { expect, test } from "bun:test";
import { enqueueWorkerMessage, scheduleWorkerHeartbeatDeadline, scheduleWorkerPing, sendWorkerAuthenticationFrames, sendWorkerStatus } from "./control-plane-gateway.ts";

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

test("logs replay rejection without closing the authenticated socket", async () => {
  const errors: unknown[][] = [];
  await sendWorkerAuthenticationFrames({
    socket: { send() {} },
    workerId: "worker",
    admissionState: "adopted",
    dispatcher: { async replayConnected() { throw new Error("replay unavailable"); } },
    logError: (...args) => errors.push(args),
  });
  expect(errors).toEqual([["Worker command replay failed", { workerId: "worker", error: "replay unavailable" }]]);
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
