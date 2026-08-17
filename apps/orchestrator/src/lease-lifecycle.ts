import { OutOfMemoryResult, type LeaseBootstrapEnvelope, type WorkerCommand, type WorkerEvent } from "@whitesmith/contracts";
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

export async function runLeaseLifecycle(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "createLease" | "requestGracefulStop" | "stopLease" | "removeLease">,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
): Promise<void> {
  const payload = { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce };
  let runtime;
  try {
    runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig });
  } catch (error) {
    console.error("Lease provisioning failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "provisioning_failed" } });
    return;
  }
  send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "sandbox_attested", occurredAt: new Date().toISOString(), payload: { ...payload, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed } });
  const sampleRuntime = runtime.sample;
  let sampling = true;
  let pressure = initialMemoryPressureState();
  let oomResult: OutOfMemoryResult | null = null;
  let resolveOom: (() => void) | undefined;
  const oomDetected = new Promise<void>(resolve => { resolveOom = resolve; });
  const sampler = sampleRuntime ? (async () => {
    while (sampling) {
      await Bun.sleep(5_000);
      if (!sampling) break;
      try {
        const sample = await sampleRuntime();
        const occurredAt = new Date().toISOString();
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
        console.error("Job resource sample failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
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
    const reportedExitCode = oomResult && exitCode === 0 ? 137 : exitCode;
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "runner.finished", occurredAt: new Date().toISOString(), payload: { ...payload, exitCode: reportedExitCode, ...(oomResult ? { oom: oomResult } : {}) } });
  } catch (error) {
    sampling = false;
    await sampler;
    console.error("Runner failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: oomResult ? "out_of_memory" : "runner_failed", ...(oomResult ? { oom: oomResult } : {}) } });
  }
  let cleanupFailed = false;
  try { await driver.stopLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease stop failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  try { await driver.removeLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease removal failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: cleanupFailed ? "lease.failed" : "lease.reaped", occurredAt: new Date().toISOString(), payload: cleanupFailed ? { ...payload, reason: "cleanup_failed" } : payload } as WorkerEvent);
}
