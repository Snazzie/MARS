import { OutOfMemoryResult, type LeaseBootstrapEnvelope, type RuntimeTerminationEvidence, type WorkerCacheProxy, type WorkerCommand, type WorkerEvent } from "@whitesmith/contracts";
import type { RuntimeDriver } from "./runtime.ts";

export type MemoryPressureState = {
  phase: "normal" | "pressured" | "oom_detected";
  consecutivePressureSamples: number;
  peakMemoryWorkingSetBytes: number;
  stopClaimed: boolean;
};

export function initialMemoryPressureState(): MemoryPressureState {
  return { phase: "normal", consecutivePressureSamples: 0, peakMemoryWorkingSetBytes: 0, stopClaimed: false };
}

export function updateMemoryPressure(
  state: MemoryPressureState,
  sample: { memoryWorkingSetBytes: number; memoryLimitBytes: number } | null,
  configuredMemoryLimitBytes: number,
): { state: MemoryPressureState; evidence: OutOfMemoryResult | null; shouldStop: boolean } {
  if (!sample || !Number.isFinite(sample.memoryWorkingSetBytes) || sample.memoryWorkingSetBytes <= 0) return { state, evidence: null, shouldStop: false };
  const workingSet = Math.round(sample.memoryWorkingSetBytes);
  const limit = configuredMemoryLimitBytes > 0 && Number.isSafeInteger(configuredMemoryLimitBytes) ? configuredMemoryLimitBytes : Math.round(sample.memoryLimitBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) return { state, evidence: null, shouldStop: false };
  const overLimit = workingSet > limit;
  const pressured = workingSet >= Math.floor(limit * 0.95);
  const next: MemoryPressureState = {
    phase: state.phase,
    consecutivePressureSamples: pressured ? state.consecutivePressureSamples + 1 : 0,
    peakMemoryWorkingSetBytes: Math.max(state.peakMemoryWorkingSetBytes, workingSet),
    stopClaimed: state.stopClaimed,
  };
  const detected = overLimit || next.consecutivePressureSamples >= 2;
  if (!detected) {
    next.phase = pressured ? "pressured" : "normal";
    return { state: next, evidence: null, shouldStop: false };
  }
  next.phase = "oom_detected";
  const shouldStop = !next.stopClaimed;
  next.stopClaimed = true;
  return {
    state: next,
    evidence: OutOfMemoryResult.parse({
      reason: "out_of_memory",
      memoryWorkingSetBytes: next.peakMemoryWorkingSetBytes,
      memoryLimitBytes: limit,
      detectedAt: new Date().toISOString(),
      gracefulStopAcknowledged: false,
    }),
    shouldStop,
  };
}

const OOM_GRACE_PERIOD_MS = 10_000;

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
      transport(expiresAt: string): WorkerCacheProxy;
    };
  },
): Promise<void> {
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  const payload = { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, correlationId };
  let workerCache: WorkerCacheProxy | undefined;
  try {
    if (options?.cacheService) workerCache = options.cacheService.transport(bootstrap.expiresAt);
  } catch (error) {
    console.error("Lease cache transport setup failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "provisioning_failed" } });
    return;
  }
  let runtime;
  try {
    runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig, ...(workerCache ? { workerCache } : {}) });
  } catch (error) {
    console.error("Lease provisioning failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "provisioning_failed" } });
    return;
  }
  send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "sandbox_attested", occurredAt: new Date().toISOString(), payload: { ...payload, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed } });
  const sampleRuntime = runtime.sample;
  let sampling = true;
  let pressure = initialMemoryPressureState();
  let oomResult: OutOfMemoryResult | null = null;
  let sampleCount = 0;
  let lastSampleOccurredAt: string | null = null;
  let samplingGapMs: number | null = null;
  let previousSampleMs = startedAt;
  let resolveOom: (() => void) | undefined;
  const oomDetected = new Promise<void>(resolve => { resolveOom = resolve; });
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
        send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "job.resource_sample", occurredAt, payload: { jobId: bootstrap.jobId, leaseId: bootstrap.leaseId, occurredAt, ...sample } });
        const result = updateMemoryPressure(pressure, sample, bootstrap.resources.memoryBytes);
        pressure = result.state;
        if (result.evidence && !oomResult) {
          oomResult = result.evidence;
          resolveOom?.();
          if (driver.requestGracefulStop) {
            const acknowledged = await driver.requestGracefulStop(bootstrap.leaseId, "out_of_memory", `Job terminated: memory limit exceeded (${(oomResult.memoryWorkingSetBytes / 1024 ** 3).toFixed(2)} GiB / ${(oomResult.memoryLimitBytes / 1024 ** 3).toFixed(2)} GiB)`).catch(() => false);
            oomResult = { ...oomResult, gracefulStopAcknowledged: acknowledged };
          }
        }
      } catch (error) {
        console.error("Job resource sample failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  })() : Promise.resolve();
  try {
    const completion = runtime.completion ?? Promise.reject(new Error("runtime completion unavailable"));
    const exitCode = await Promise.race([
      completion,
      oomDetected.then(() => Bun.sleep(OOM_GRACE_PERIOD_MS).then(() => { throw new Error("OOM graceful stop timed out"); })),
    ]);
    sampling = false;
    await sampler;
    const termination = runtime.termination ?? fallbackTermination("child_exit", exitCode, Date.now() - startedAt, sampleCount, lastSampleOccurredAt, samplingGapMs);
    const reportedExitCode = oomResult && exitCode === 0 ? 137 : exitCode;
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "runner.finished", occurredAt: new Date().toISOString(), payload: { ...payload, exitCode: reportedExitCode, termination, ...(oomResult ? { oom: oomResult } : {}) } });
  } catch (error) {
    sampling = false;
    await sampler;
    const termination = runtime.termination ?? fallbackTermination("child_disappeared", null, Date.now() - startedAt, sampleCount, lastSampleOccurredAt, samplingGapMs);
    console.error("Runner failed", { leaseId: bootstrap.leaseId, correlationId, cause: termination.cause, error: error instanceof Error ? error.message : String(error) });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: oomResult ? "out_of_memory" : "runner_failed", termination, ...(oomResult ? { oom: oomResult } : {}) } });
  }
  if (driver.collectRawDiagnostics) {
    try {
      const diagnosticId = crypto.randomUUID();
      const raw = await driver.collectRawDiagnostics(bootstrap.leaseId);
      const chunkSize = 96 * 1024;
      const chunks = raw.length ? Math.ceil(raw.length / chunkSize) : 1;
      for (let sequence = 0; sequence < chunks; sequence += 1) {
        send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "diagnostic.chunk", occurredAt: new Date().toISOString(), payload: { jobId: bootstrap.jobId, leaseId: bootstrap.leaseId, diagnosticId, sequence, content: raw.slice(sequence * chunkSize, (sequence + 1) * chunkSize), final: sequence === chunks - 1 } });
      }
    } catch (error) {
      console.error("Raw container diagnostics failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (preserveLeasesForDebugging(options)) {
    console.warn("Lease cleanup disabled for debugging", { leaseId: bootstrap.leaseId, correlationId });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "debug_preserve" } });
    return;
  }
  let cleanupFailed = false;
  try { await driver.stopLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease stop failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) }); }
  try { await driver.removeLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease removal failed", { leaseId: bootstrap.leaseId, correlationId, error: error instanceof Error ? error.message : String(error) }); }
  send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: cleanupFailed ? "lease.failed" : "lease.reaped", occurredAt: new Date().toISOString(), payload: cleanupFailed ? { ...payload, reason: "cleanup_failed" } : payload } as WorkerEvent);
}
