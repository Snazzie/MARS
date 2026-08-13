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
export const RunnerJitConfig = z.object({
  encodedJitConfig: z.string().min(1),
  runnerName: z.string().min(1).max(128),
  labels: z.array(z.string().min(1)).min(1),
  expiresAt: z.string().datetime(),
}).strict();
export type RunnerJitConfig = z.infer<typeof RunnerJitConfig>;
export const LeaseBootstrapEnvelope = z.object({
  leaseId: z.string().uuid(),
  nonce: z.string().min(32),
  encodedJitConfig: z.string().min(1),
  expiresAt: z.string().datetime(),
  imageDigest: z.string().min(1),
  resources: PoolResources,
}).strict();
export type LeaseBootstrapEnvelope = z.infer<typeof LeaseBootstrapEnvelope>;
export const LeaseLifecycleEvent = z.object({
  leaseId: z.string().uuid(),
  nonce: z.string().min(32),
  state: z.enum(["runner_started", "job_started", "job_completed", "job_failed", "reaped"]),
  conclusion: z.string().nullable().optional(),
  occurredAt: z.string().datetime(),
}).strict();
export type LeaseLifecycleEvent = z.infer<typeof LeaseLifecycleEvent>;
export const WorkerCommand = z.object({ version: z.literal(1), id: z.string().uuid(), type: z.string().min(1), workerId: z.string().uuid(), leaseId: z.string().uuid().nullable(), occurredAt: z.string().datetime(), payload: z.record(z.unknown()) });
export const WorkerEvent = z.object({ version: z.literal(1), id: z.string().uuid(), workerId: z.string().uuid(), type: z.string().min(1), occurredAt: z.string().datetime(), payload: z.record(z.unknown()) });
export const WorkerEventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command.accepted"), payload: z.object({ commandId: z.string().uuid(), leaseId: z.string().uuid().nullable() }).strict() }),
  z.object({ type: z.literal("sandbox_attested"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32), runtimeInstanceId: z.string().min(1), observed: z.object({ vcpu: positiveSafe, memoryBytes: positiveSafe, storageBytes: positiveSafe }).strict() }).strict() }),
  z.object({ type: z.literal("runner.finished"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32), exitCode: z.number().int().nonnegative() }).strict() }),
  z.object({ type: z.literal("lease.reaped"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32) }).strict() }),
  z.object({ type: z.literal("lease.failed"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32), reason: z.enum(["provisioning_failed","runner_failed","cleanup_failed"]) }).strict() }),
]);
export const WorkerApplianceConfiguration = z.object({ vcpu: positiveSafe, memoryBytes: positiveSafe, storageBytes: positiveSafe }).strict();
export const WorkerConfiguration = z.object({ appliance: WorkerApplianceConfiguration, runtime: WorkerLimits }).strict();
export const WorkerConfigurePayload = z.object({ workerId: z.string().uuid(), appliance: WorkerApplianceConfiguration, runtime: WorkerLimits, revision: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const WorkerConfiguredPayload = z.object({ commandId: z.string().uuid(), workerId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/), observed: WorkerConfiguration }).strict();
export const BrowserInvalidation = z.object({ version: z.literal(1), sequence: positiveSafe, organizationId: z.string(), type: z.literal("invalidate"), keys: z.array(z.array(z.unknown())), occurredAt: z.string().datetime() });
export type WorkerCommand = z.infer<typeof WorkerCommand>;
export type WorkerEvent = z.infer<typeof WorkerEvent>;
export type BrowserInvalidation = z.infer<typeof BrowserInvalidation>;
export { positiveSafe };
const boundedResource = z.number().int().finite().min(0).max(Number.MAX_SAFE_INTEGER);
export const WorkerDoctorData = z.object({ nestedKvm: z.boolean().optional(), kvmModules: z.boolean().optional(), probe: z.boolean().optional(), egress: z.boolean().optional(), imageSignatures: z.boolean().optional(), blockVolume: z.boolean().optional(), actualVcpu: boundedResource.optional(), actualMemoryBytes: boundedResource.optional(), actualStorageBytes: boundedResource.optional(), freeVcpu: boundedResource.optional(), freeMemoryBytes: boundedResource.optional(), freeStorageBytes: boundedResource.optional() }).strict();
export const WorkerCapacityData = z.object({ actualVcpu: boundedResource, actualMemoryBytes: boundedResource, actualStorageBytes: boundedResource, freeVcpu: boundedResource, freeMemoryBytes: boundedResource, freeStorageBytes: boundedResource }).strict();
export const WorkerBootstrapRequest = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  platform: RuntimePlatform,
  publicKey: z.string().min(1),
  encryptionPublicKey: z.string().min(1),
  vmUuid: z.string().uuid(),
  machineUuid: z.string().uuid(),
  doctor: WorkerDoctorData,
  capacity: WorkerCapacityData,
}).strict();
export type WorkerBootstrapRequest = z.infer<typeof WorkerBootstrapRequest>;
export const PendingWorkerRequest = WorkerBootstrapRequest.omit({ code: true, encryptionPublicKey: true }).extend({ limits: WorkerLimits.nullable() });
export type PendingWorkerRequest = z.infer<typeof PendingWorkerRequest>;
export const ApproveWorkerRequest = z.object({ limits: WorkerLimits }).strict();
export type ApproveWorkerRequest = z.infer<typeof ApproveWorkerRequest>;

export type WorkerState = z.infer<typeof WorkerState>;
export type ConnectionState = z.infer<typeof ConnectionState>;
export type ConfigurationState = z.infer<typeof ConfigurationState>;
export type WorkerDoctorData = z.infer<typeof WorkerDoctorData>;
export type WorkerCapacityData = z.infer<typeof WorkerCapacityData>;