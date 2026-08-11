import { WorkerConfiguration, WorkerConfigurePayload } from "@whitesmith/contracts";
import type { WorkerCommand, WorkerEvent } from "@whitesmith/contracts";

export type LinuxWorkerResources = {
  appliance: { vcpu: number; memoryBytes: number; storageBytes: number };
  runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
};

/** Apply the durable worker.configure command and report the exact observed values. */
export function applyLinuxWorkerConfigure(command: WorkerCommand, resources: LinuxWorkerResources): WorkerEvent {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime });
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
