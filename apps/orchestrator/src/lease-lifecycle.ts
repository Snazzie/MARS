import { type LeaseBootstrapEnvelope, type RuntimeTerminationEvidence, type WorkerCacheProxy, type WorkerCommand, type WorkerEvent } from "@mars/contracts";
import type { RuntimeDriver } from "./runtime.ts";


function fallbackTermination(cause: RuntimeTerminationEvidence["cause"], exitCode: number | null, elapsedMs: number, sampleCount: number, lastSampleOccurredAt: string | null, samplingGapMs: number | null): RuntimeTerminationEvidence {
  return {
    cause,
    exitCode,
    exitObserved: cause === "child_exit",
    elapsedMs,
    childPid: null,
    servicePid: null,
    activeProcessCount: null,
    peakProcessCount: null,
    peakProcessMemoryBytes: null,
    peakJobMemoryBytes: null,
    kernelTimeMs: null,
    userTimeMs: null,
    lastSampleOccurredAt,
    sampleCount,
    samplingGapMs,
  };
}
function preserveLeasesForDebugging(options?: { preserveLeases?: () => boolean }): boolean {
  return options?.preserveLeases?.() === true;
}


export async function runLeaseLifecycle(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "createLease" | "requestGracefulStop" | "stopLease" | "removeLease" | "collectRawDiagnostics">,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
  options?: {
    preserveLeases?: () => boolean;
    cacheService?: {
      transport(leaseId: string, expiresAt: string): WorkerCacheProxy;
      unregisterLease(leaseId: string): void;
    };
  },
): Promise<void> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const payload = { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, correlationId };
  const emit = (workerEvent: WorkerEvent): void => {
    try {
      send(workerEvent);
    } catch (error) {
      console.error("Worker event delivery failed", { workerId: command.workerId, leaseId: bootstrap.leaseId, type: workerEvent.type, error: error instanceof Error ? error.message : String(error) });
    }
  };
  let workerCache: WorkerCacheProxy | undefined;
  try {
    if (options?.cacheService) workerCache = options.cacheService.transport(bootstrap.leaseId, bootstrap.expiresAt);
  } catch (error) {
    console.error("Lease cache transport setup failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
    emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "provisioning_failed" } });
    return;
  }
  try {
  let runtime;
  try {
    runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, contractVersion: bootstrap.contractVersion, guestPlatform: bootstrap.guestPlatform, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig, ...(workerCache ? { workerCache } : {}) });
  } catch (error) {
    console.error("Lease provisioning failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
    emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "provisioning_failed" } });
    return;
  }
  emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "sandbox_attested", occurredAt: new Date().toISOString(), payload: { ...payload, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed } });
  let logSequence = 0;
  const logs = runtime.logs;
  const runnerLogs = logs ? (async () => {
    for await (const content of logs) {
      for (let offset = 0; offset < content.length; offset += 240 * 1024) {
        const occurredAt = new Date().toISOString();
        emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "job.log", occurredAt, payload: { jobId: bootstrap.jobId, stepId: null, sequence: logSequence++, content: content.slice(offset, offset + 240 * 1024), occurredAt } });
      }
    }
  })().catch(error => {
    console.error("Runner log collection failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
  }) : Promise.resolve();
  const sampleRuntime = runtime.sample;
  let sampling = true;
  let sampleCount = 0;
  let lastSampleOccurredAt: string | null = null;
  let samplingGapMs: number | null = null;
  let previousSampleMs = startedAt;
  const sampler = sampleRuntime ? (async () => {
    while (sampling) {
      await Bun.sleep(5_000);
      if (!sampling) break;
      try {
        const sample = await sampleRuntime();
        const occurredAt = new Date().toISOString();
        const occurredMs = Date.parse(occurredAt);
        sampleCount += 1;
        lastSampleOccurredAt = occurredAt;
        samplingGapMs = Math.max(samplingGapMs ?? 0, occurredMs - previousSampleMs);
        previousSampleMs = occurredMs;
        emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "job.resource_sample", occurredAt, payload: { jobId: bootstrap.jobId, leaseId: bootstrap.leaseId, occurredAt, ...sample } });
      } catch (error) {
        console.error("Job resource sample failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  })() : Promise.resolve();
  try {
    const exitCode = await (runtime.completion ?? Promise.reject(new Error("runtime completion unavailable")));
    sampling = false;
    await sampler;
    await runnerLogs;
    const termination = runtime.termination ?? fallbackTermination("child_exit", exitCode, Date.now() - startedAt, sampleCount, lastSampleOccurredAt, samplingGapMs);
    emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "runner.finished", occurredAt: new Date().toISOString(), payload: { ...payload, exitCode, termination } });
  } catch (error) {
    sampling = false;
    await sampler;
    await runnerLogs;
    const termination = runtime.termination ?? fallbackTermination("child_disappeared", null, Date.now() - startedAt, sampleCount, lastSampleOccurredAt, samplingGapMs);
    console.error("Runner failed", { leaseId: bootstrap.leaseId, correlationId, cause: termination.cause, error: error instanceof Error ? error.message : String(error) });
    emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "runner_failed", termination } });
  }
  if (driver.collectRawDiagnostics) {
    try {
      const diagnosticId = crypto.randomUUID();
      const raw = await driver.collectRawDiagnostics(bootstrap.leaseId);
      const chunkSize = 96 * 1024;
      const chunks = raw.length ? Math.ceil(raw.length / chunkSize) : 1;
      for (let sequence = 0; sequence < chunks; sequence += 1) {
        emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "diagnostic.chunk", occurredAt: new Date().toISOString(), payload: { jobId: bootstrap.jobId, leaseId: bootstrap.leaseId, diagnosticId, sequence, content: raw.slice(sequence * chunkSize, (sequence + 1) * chunkSize), final: sequence === chunks - 1 } });
      }
    } catch (error) {
      console.error("Raw container diagnostics failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (preserveLeasesForDebugging(options)) {
    console.warn("Lease cleanup disabled for debugging", { leaseId: bootstrap.leaseId, correlationId });
    emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "debug_preserve" } });
    return;
  }
  let cleanupFailed = false;
  try { await driver.stopLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease stop failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) }); }
  try { await driver.removeLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease removal failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) }); }
  emit({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: cleanupFailed ? "lease.failed" : "lease.reaped", occurredAt: new Date().toISOString(), payload: cleanupFailed ? { ...payload, reason: "cleanup_failed" } : payload } as WorkerEvent);
  } finally {
    options?.cacheService?.unregisterLease(bootstrap.leaseId);
  }
}
