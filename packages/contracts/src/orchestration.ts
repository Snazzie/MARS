import { z } from "zod";

export const RuntimePlatform = z.enum(["linux-x64", "windows-x64", "macos-arm64"]);
export type RuntimePlatform = z.infer<typeof RuntimePlatform>;
export const RuntimeDriverName = z.enum(["kata-k3s", "windows-hyperv", "tart-vm"]);
export type RuntimeDriverName = z.infer<typeof RuntimeDriverName>;
const positiveSafe = z.number().int().positive().safe();
export const WorkerLimits = z.object({ maxVcpuPerPod: positiveSafe, maxMemoryBytesPerPod: positiveSafe, maxStorageBytesPerPod: positiveSafe, maxConcurrentPods: positiveSafe });
export type WorkerLimits = z.infer<typeof WorkerLimits>;
export const PoolResources = z.object({ vcpu: positiveSafe, memoryBytes: positiveSafe, storageBytes: positiveSafe, concurrency: positiveSafe });
export type PoolResources = z.infer<typeof PoolResources>;
export const WorkerState = z.enum(["pending", "adopted", "rejected", "revoked"]);
export const ConnectionState = z.enum(["offline", "online"]);
export const ConfigurationState = z.enum(["unconfigured", "ready", "error"]);
export const LeaseState = z.enum(["requested", "dispatched", "provisioning", "sandbox_ready", "online", "busy", "completed", "reaping", "reaped", "failed"]);
export const WorkerCommand = z.object({ version: z.literal(1), id: z.string().uuid(), type: z.string().min(1), workerId: z.string().uuid(), leaseId: z.string().uuid().nullable(), occurredAt: z.string().datetime(), payload: z.record(z.unknown()) });
export const WorkerEvent = z.object({ version: z.literal(1), id: z.string().uuid(), workerId: z.string().uuid(), type: z.string().min(1), occurredAt: z.string().datetime(), payload: z.record(z.unknown()) });
export const BrowserInvalidation = z.object({ version: z.literal(1), sequence: positiveSafe, organizationId: z.string(), type: z.literal("invalidate"), keys: z.array(z.array(z.unknown())), occurredAt: z.string().datetime() });
export type WorkerCommand = z.infer<typeof WorkerCommand>;
export type WorkerEvent = z.infer<typeof WorkerEvent>;
export type BrowserInvalidation = z.infer<typeof BrowserInvalidation>;
export { positiveSafe };
const boundedNonNegative = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
export const WorkerDoctorData = z.object({ nestedKvm: z.boolean().optional(), kvmModules: z.boolean().optional(), probe: z.boolean().optional(), egress: z.boolean().optional(), imageSignatures: z.boolean().optional(), blockVolume: z.boolean().optional(), actualVcpu: boundedNonNegative.optional(), actualMemoryBytes: boundedNonNegative.optional(), actualStorageBytes: boundedNonNegative.optional(), freeVcpu: boundedNonNegative.optional(), freeMemoryBytes: boundedNonNegative.optional(), freeStorageBytes: boundedNonNegative.optional() }).strict();
export const WorkerCapacityData = z.object({ actualVcpu: boundedNonNegative, actualMemoryBytes: boundedNonNegative, actualStorageBytes: boundedNonNegative, freeVcpu: boundedNonNegative, freeMemoryBytes: boundedNonNegative, freeStorageBytes: boundedNonNegative }).strict();
export const WorkerBootstrapRequest = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  platform: RuntimePlatform,
  publicKey: z.string().min(1),
  vmUuid: z.string().uuid(),
  machineUuid: z.string().uuid(),
  limits: WorkerLimits,
  doctor: WorkerDoctorData,
  capacity: WorkerCapacityData,
}).strict();
export type WorkerBootstrapRequest = z.infer<typeof WorkerBootstrapRequest>;
export const PendingWorkerRequest = WorkerBootstrapRequest.omit({ code: true });
export type PendingWorkerRequest = z.infer<typeof PendingWorkerRequest>;
export const ApproveWorkerRequest = z.object({ organizationId: z.string().uuid(), limits: WorkerLimits }).strict();
export type ApproveWorkerRequest = z.infer<typeof ApproveWorkerRequest>;
