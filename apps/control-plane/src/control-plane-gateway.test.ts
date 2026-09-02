import { enqueueWorkerMessage, scheduleWorkerPing } from "./control-plane-gateway.ts";

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
  expect(capturedDelay).toBe(30_000);
  capturedCallback();
  expect(sendCount).toBe(1);
});

const gatewaySource = await Bun.file(new URL("./control-plane-gateway.ts", import.meta.url)).text();

test("starts worker heartbeat polling after authentication", () => {
  const authenticatedBranchStart = gatewaySource.indexOf('frame.type === "authenticate"');
  const doctorBranchStart = gatewaySource.indexOf('frame.type === "doctor"', authenticatedBranchStart);
  const authenticatedBranch = gatewaySource.slice(authenticatedBranchStart, doctorBranchStart);
  expect(authenticatedBranch).toContain('ws.send(JSON.stringify({ version: 1, type: "authenticated"');
  expect(authenticatedBranch).toContain('ws.send(JSON.stringify({ version: 1, type: "ping" }));');
});

test("workers answer heartbeat pings with JSON frames", async () => {
  for (const path of ["../../orchestrator/src/linux-agent.ts", "../../orchestrator/src/mac-agent.ts", "../../orchestrator/src/windows-agent.ts"]) {
    const source = await Bun.file(new URL(path, import.meta.url)).text();
    expect(source).toContain('ws.send(JSON.stringify({ version: 1, type: "pong", workerId: identity.workerId }))');
  }
});
test("schedules the next worker ping after pong", () => {
  const pongBranchStart = gatewaySource.indexOf('frame.type === "pong"');
  const nextBranchStart = gatewaySource.indexOf('} else if (ws.data.authenticated', pongBranchStart);
  const pongBranch = gatewaySource.slice(pongBranchStart, nextBranchStart);
  expect(pongBranch).toContain("scheduleWorkerPing");
  expect(pongBranch).not.toContain('\n        ws.send(JSON.stringify({ version: 1, type: "ping" }))');
});
test("validates worker doctor reports before persistence and acknowledgement", () => {
  const doctorBranchStart = gatewaySource.indexOf('frame.type === "doctor"');
  const pongBranchStart = gatewaySource.indexOf('frame.type === "pong"', doctorBranchStart);
  const doctorBranch = gatewaySource.slice(doctorBranchStart, pongBranchStart);
  expect(doctorBranch).toContain("WorkerDoctorReport.safeParse(frame.payload)");
  expect(doctorBranch).toContain("if (!parsed.success) return;");
  expect(doctorBranch).toContain("await options.db`update workers set doctor=");
  expect(doctorBranch).toContain("if (doctorPayload.doctor.activeLeases) {");
  expect(doctorBranch).not.toContain("?? []");
  expect(doctorBranch).toContain('type: "doctor_ack"');
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
