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
  try {
    const exitCode = await runtime.completion;
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "runner.finished", occurredAt: new Date().toISOString(), payload: { ...payload, exitCode } });
  } catch (error) {
    console.error("Runner failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.failed", occurredAt: new Date().toISOString(), payload: { ...payload, reason: "runner_failed" } });
  }
  let cleanupFailed = false;
  try { await driver.stopLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease stop failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  try { await driver.removeLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("Lease removal failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  send({ version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: cleanupFailed ? "lease.failed" : "lease.reaped", occurredAt: new Date().toISOString(), payload: cleanupFailed ? { ...payload, reason: "cleanup_failed" } : payload });
}
