import { WorkerConfiguration, WorkerConfigurePayload, WorkerCommand, type WorkerEvent } from "@whitesmith/contracts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";
import type { LibvirtVmDriver } from "./libvirt-vm.ts";
import type { WorkerLimits } from "@whitesmith/contracts";
export type LinuxWorkerResources = {
  appliance: { vcpu: number; memoryBytes: number; storageBytes: number };
  runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
};

/** Apply the durable worker.configure command and report the exact observed values. */
export function applyLinuxWorkerConfigure(command: WorkerCommand, resources: LinuxWorkerResources): WorkerEvent {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms });
  resources.appliance = observed.appliance;
  resources.runtime = observed.runtime;
  return {
    version: 1,
    id: crypto.randomUUID(),
    workerId: command.workerId,
    type: "worker.configured",
    occurredAt: new Date().toISOString(),
    payload: { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed },
  };
}

export function handleLinuxWorkerCommand(command: WorkerCommand, resources: LinuxWorkerResources): WorkerEvent {
  if (command.type !== "worker.configure") throw new Error(`unsupported worker command: ${command.type}`);
  return applyLinuxWorkerConfigure(command, resources);
}

export type LinuxWorkerCommandContext = {
  driver: Pick<LibvirtVmDriver, "createLease" | "stopLease" | "removeLease">;
  encryptionPrivateKey: string;
  runtimeReady: () => boolean;
  send: (event: WorkerEvent) => void;
  activeLeases?: Map<string, Promise<void>>;
};

export async function handleLinuxWorkerCommandWithContext(command: WorkerCommand, resources: LinuxWorkerResources, context: LinuxWorkerCommandContext): Promise<WorkerEvent | void> {
  if (command.type === "worker.configure") return handleLinuxWorkerCommand(command, resources);
  if (command.type === "linux-vm.stop_lease") {
    if (!command.leaseId) throw new Error("lease_id_required");
    await context.driver.stopLease(command.leaseId);
    const event = { version: 1 as const, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.reaped", occurredAt: new Date().toISOString(), payload: { leaseId: command.leaseId } };
    context.send(event);
    return event;
  }
  if (command.type !== "linux-vm.create_lease") throw new Error(`unsupported worker command: ${command.type}`);
  if (!context.runtimeReady()) throw new Error("worker_runtime_not_ready");
  const payload = command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] };
  if (!payload.bootstrapCiphertext) throw new Error("bootstrap_ciphertext_missing");
  const bootstrap = openLeaseBootstrap(payload.bootstrapCiphertext, context.encryptionPrivateKey);
  if (command.leaseId !== bootstrap.leaseId) throw new Error("lease_id_mismatch");
  const active = context.activeLeases ?? new Map<string, Promise<void>>();
  if (active.has(bootstrap.leaseId)) return;
  const lifecycle = runLeaseLifecycle(command, context.driver, bootstrap, context.send);
  active.set(bootstrap.leaseId, lifecycle);
  void lifecycle.finally(() => active.delete(bootstrap.leaseId));
}

export async function runLinuxWorker(baseUrl: string, driver: LibvirtVmDriver, limits: WorkerLimits): Promise<void> {
  if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required");
  const required = ["WHITESMITH_GOLDEN_DISK", "WHITESMITH_GOLDEN_DIGEST", "WHITESMITH_DOMAIN_TEMPLATE", "WHITESMITH_CLONE_ROOT", "WHITESMITH_CHANNEL_ROOT", "WHITESMITH_LIBVIRT_NETWORK"];
  const missing = required.filter((name) => !Bun.env[name]);
  if (missing.length) throw new Error(`missing Linux worker configuration: ${missing.join(", ")}`);
  const host = await driver.validateHost();
  if (!host.runtimeReady) throw new Error(host.remediation ?? "linux runtime host validation failed");
  driver.validatePool({ vcpu: Math.min(limits.maxVcpuPerPod, 1), memoryBytes: Math.min(limits.maxMemoryBytesPerPod, 1024 ** 3), storageBytes: Math.min(limits.maxStorageBytesPerPod, 1024 ** 3), concurrency: 1 });
  await driver.reconcileOrphans();
  throw new Error(`Linux worker WebSocket enrollment is unavailable for ${baseUrl}`);
}
