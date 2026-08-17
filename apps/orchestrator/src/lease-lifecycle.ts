import type { LeaseBootstrapEnvelope, WorkerCommand, WorkerEvent } from "@whitesmith/contracts";
import type { RuntimeDriver } from "./runtime.ts";

export async function runLeaseLifecycle(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "createLease" | "stopLease" | "removeLease">,
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
  const sampler = sampleRuntime ? (async () => {
    while (sampling) {
      await Bun.sleep(5_000);
      if (!sampling) break;
      try {
        const sample = await sampleRuntime();
        send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "job.resource_sample", occurredAt: new Date().toISOString(), payload: { jobId: bootstrap.jobId, leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), ...sample } });
      } catch (error) {
        console.error("Job resource sample failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  })() : Promise.resolve();
  try {
    const exitCode = await runtime.completion;
    sampling = false;
    await sampler;
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "runner.finished", occurredAt: new Date().toISOString(), payload: { ...payload, exitCode } });
  } catch (error) {
    sampling = false;
    await sampler;
    console.error("Runner failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "runner_failed" } });
  }
  let cleanupFailed = false;
  try { await driver.stopLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease stop failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  try { await driver.removeLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease removal failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: cleanupFailed ? "lease.failed" : "lease.reaped", occurredAt: new Date().toISOString(), payload: cleanupFailed ? { ...payload, reason: "cleanup_failed" } : payload });
}
