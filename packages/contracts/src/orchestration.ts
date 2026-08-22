import { z } from "zod";

export const RuntimePlatform = z.enum(["linux-x64", "windows-x64", "macos-arm64"]);
export type RuntimePlatform = z.infer<typeof RuntimePlatform>;
export const GuestPlatform = RuntimePlatform;
export type GuestPlatform = RuntimePlatform;
export const WorkerGuestPlatforms = z.array(GuestPlatform).min(1).refine((platforms) => new Set(platforms).size === platforms.length, "Guest platforms must be unique");
export type WorkerGuestPlatforms = z.infer<typeof WorkerGuestPlatforms>;
export function validateWorkerGuestPlatforms(hostPlatform: RuntimePlatform, guestPlatforms: WorkerGuestPlatforms): boolean {
  return guestPlatforms.length === 1 && guestPlatforms[0] === hostPlatform;
}
export const RuntimeDriverName = z.enum(["linux-libvirt-vm", "windows-hyperv", "windows-hyperv-container", "tart-vm"]);
export type RuntimeDriverName = z.infer<typeof RuntimeDriverName>;
const positiveSafe = z.number().int().positive().safe();
export const OutOfMemoryResult = z.object({
  reason: z.literal("out_of_memory"),
  memoryWorkingSetBytes: positiveSafe,
  memoryLimitBytes: positiveSafe,
  detectedAt: z.string().datetime({ offset: true }),
  gracefulStopAcknowledged: z.boolean(),
}).strict();
export type OutOfMemoryResult = z.infer<typeof OutOfMemoryResult>;
export const RuntimeTerminationCause = z.enum(["child_exit", "service_stop", "forced_job_termination", "child_disappeared", "service_host_error"]);
export type RuntimeTerminationCause = z.infer<typeof RuntimeTerminationCause>;
export const RuntimeTerminationEvidence = z.object({
  cause: RuntimeTerminationCause,
  exitCode: z.number().int().nonnegative().nullable(),
  exitObserved: z.boolean(),
  elapsedMs: z.number().int().nonnegative().safe(),
  childPid: z.number().int().positive().nullable(),
  servicePid: z.number().int().positive().nullable(),
  activeProcessCount: z.number().int().nonnegative().nullable(),
  peakProcessCount: z.number().int().nonnegative().nullable(),
  peakProcessMemoryBytes: z.number().int().nonnegative().nullable(),
  peakJobMemoryBytes: z.number().int().nonnegative().nullable(),
  kernelTimeMs: z.number().int().nonnegative().nullable(),
  userTimeMs: z.number().int().nonnegative().nullable(),
  lastSampleOccurredAt: z.string().datetime({ offset: true }).nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  samplingGapMs: z.number().int().nonnegative().nullable(),
}).strict();
export type RuntimeTerminationEvidence = z.infer<typeof RuntimeTerminationEvidence>;
export const WorkerLimits = z.object({ maxVcpuPerPod: positiveSafe, maxMemoryBytesPerPod: positiveSafe, maxStorageBytesPerPod: positiveSafe, maxConcurrentPods: positiveSafe });
export type WorkerLimits = z.infer<typeof WorkerLimits>;
export const PoolResources = z.object({ vcpu: positiveSafe, memoryBytes: positiveSafe, storageBytes: positiveSafe, concurrency: positiveSafe });
export type PoolResources = z.infer<typeof PoolResources>;
export const RunnerJitConfig = z.object({
  encodedJitConfig: z.string().min(1),
  runnerName: z.string().min(1).max(128),
  labels: z.array(z.string().min(1)).min(1),
  expiresAt: z.string().datetime(),
}).strict();
export type RunnerJitConfig = z.infer<typeof RunnerJitConfig>;
export const WorkerState = z.enum(["pending", "adopted", "rejected", "revoked"]);
export const ConnectionState = z.enum(["offline", "online"]);
export const ConfigurationState = z.enum(["unconfigured", "applying", "ready", "error"]);
export const LeaseBootstrapEnvelope = z.object({
  leaseId: z.string().uuid(),
  jobId: z.string().uuid(),
  nonce: z.string().min(32),
  guestPlatform: GuestPlatform,
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
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const WindowsImageBuildArtifact = z.object({ url: z.string().url().refine((value) => value.startsWith("https://") || value.startsWith("http://localhost") || value.startsWith("http://127.0.0.1"), "build artifact URL must use HTTPS"), sha256: sha256Hex }).strict();
export const WorkerImageBuildSpec = z.object({ image: z.literal("whitesmith/windows-job:local") }).strict();
export const WorkerBuildImagePayload = WorkerImageBuildSpec.extend({
  buildId: z.string().uuid(),
  baseImage: z.string().regex(/^mcr\.microsoft\.com\/windows\/server:ltsc2025@sha256:[0-9a-f]{64}$/),
  runner: WindowsImageBuildArtifact,
  git: WindowsImageBuildArtifact,
  vcRuntime: WindowsImageBuildArtifact,
  artifacts: z.object({
    builder: WindowsImageBuildArtifact,
    verifier: WindowsImageBuildArtifact,
    containerfile: WindowsImageBuildArtifact,
    entrypoint: WindowsImageBuildArtifact,
    jobAgent: WindowsImageBuildArtifact,
  }).strict(),
  contentSha256: sha256Hex,
}).strict();
export type WorkerBuildImagePayload = z.infer<typeof WorkerBuildImagePayload>;
export function workerBuildImageContentDescriptor(payload: Omit<WorkerBuildImagePayload, "buildId" | "contentSha256">): string {
  return JSON.stringify({
    image: payload.image,
    baseImage: payload.baseImage,
    runner: payload.runner,
    git: payload.git,
    vcRuntime: payload.vcRuntime,
    artifacts: payload.artifacts,
  });
}
export const WorkerBuildImageEventPayload = z.object({ commandId: z.string().uuid(), buildId: z.string().uuid(), image: z.string().min(1), imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(), contentSha256: sha256Hex, runtimeReady: z.boolean(), message: z.string().min(1).max(1000).optional() }).strict();
export const WorkerBuildImageFailedPayload = WorkerBuildImageEventPayload.extend({ runtimeReady: z.literal(false), failureStage: z.string().min(1).max(64) }).strict();
export const WorkerCommand = z.object({ version: z.literal(1), id: z.string().uuid(), type: z.string().min(1), workerId: z.string().uuid(), leaseId: z.string().uuid().nullable(), occurredAt: z.string().datetime(), payload: z.record(z.unknown()) });
export const WorkerEvent = z.object({ version: z.literal(1), id: z.string().uuid(), workerId: z.string().uuid(), type: z.string().min(1), occurredAt: z.string().datetime(), payload: z.record(z.unknown()) });
export const WorkerEventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command.accepted"), payload: z.object({ commandId: z.string().uuid(), leaseId: z.string().uuid().nullable() }).strict() }),
  z.object({ type: z.literal("sandbox_attested"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32), runtimeInstanceId: z.string().min(1), observed: z.object({ vcpu: positiveSafe, memoryBytes: positiveSafe, storageBytes: positiveSafe }).strict(), correlationId: z.string().uuid().optional() }).strict() }),
  z.object({ type: z.literal("runner.finished"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32), exitCode: z.number().int().nonnegative(), oom: OutOfMemoryResult.optional(), termination: RuntimeTerminationEvidence.optional(), correlationId: z.string().uuid().optional() }).strict() }),
  z.object({ type: z.literal("worker.build_completed"), payload: WorkerBuildImageEventPayload }).strict(),
  z.object({ type: z.literal("worker.build_failed"), payload: WorkerBuildImageFailedPayload }).strict(),
  z.object({ type: z.literal("lease.reaped"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32), correlationId: z.string().uuid().optional() }).strict() }),
  z.object({ type: z.literal("lease.failed"), payload: z.object({ commandId: z.string().uuid().optional(), leaseId: z.string().uuid(), nonce: z.string().min(32), reason: z.enum(["provisioning_failed","runner_failed","cleanup_failed","debug_preserve","out_of_memory"]), oom: OutOfMemoryResult.optional(), termination: RuntimeTerminationEvidence.optional(), correlationId: z.string().uuid().optional() }).strict() }),
  z.object({ type: z.literal("diagnostic.chunk"), payload: z.object({ jobId: z.string().uuid(), leaseId: z.string().uuid(), diagnosticId: z.string().uuid(), sequence: z.number().int().nonnegative(), content: z.string().max(128 * 1024), final: z.boolean() }).strict() }),
  z.object({ type: z.literal("job.log"), payload: z.object({ jobId: z.string().uuid(), stepId: z.string().uuid().nullable(), sequence: z.number().int().nonnegative(), content: z.string().max(256 * 1024), occurredAt: z.string().datetime() }).strict() }),
  z.object({ type: z.literal("job.resource_sample"), payload: z.object({ jobId: z.string().uuid(), leaseId: z.string().uuid(), occurredAt: z.string().datetime(), cpuUsagePercent: z.number().min(0).max(100), cpuTimeMs: z.number().int().nonnegative(), memoryWorkingSetBytes: z.number().int().nonnegative(), memoryLimitBytes: z.number().int().positive() }).strict() }),
]);
export const WorkerApplianceConfiguration = z.object({ vcpu: positiveSafe, memoryBytes: positiveSafe, storageBytes: positiveSafe }).strict();
export const WorkerConfiguration = z.object({ appliance: WorkerApplianceConfiguration, runtime: WorkerLimits, guestPlatforms: WorkerGuestPlatforms.default(["macos-arm64"]) }).strict();
export const WorkerConfigurePayload = z.object({ workerId: z.string().uuid(), appliance: WorkerApplianceConfiguration, runtime: WorkerLimits, guestPlatforms: WorkerGuestPlatforms, revision: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const WorkerConfiguredPayload = z.object({ commandId: z.string().uuid(), workerId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/), observed: WorkerConfiguration }).strict();
const boundedResource = z.number().int().finite().min(0).max(Number.MAX_SAFE_INTEGER);
export const WorkerDoctorData = z.object({ nestedKvm: z.boolean().optional(), kvmModules: z.boolean().optional(), probe: z.boolean().optional(), egress: z.boolean().optional(), imageSignatures: z.boolean().optional(), blockVolume: z.boolean().optional(), libvirtReady: z.boolean().optional(), networkReady: z.boolean().optional(), cloneStorageReady: z.boolean().optional(), realVmSmoke: z.boolean().optional(), smokeArtifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(), smokeObservedAt: z.string().datetime({ offset: true }).optional(), runtimeMode: z.enum(["container", "vm", "tart"]).optional(), artifactSource: z.enum(["worker_local", "registry", "template"]).optional(), artifactIdentity: z.string().min(1).optional(), artifactDigest: z.string().regex(/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/).optional(), runtimeReady: z.boolean().optional(), runtimeBuildState: z.enum(["idle", "building", "ready", "failed"]).optional(), runtimeBuildMessage: z.string().max(1000).nullable().optional(), remediation: z.string().nullable().optional(), actualVcpu: boundedResource.optional(), actualMemoryBytes: boundedResource.optional(), actualStorageBytes: boundedResource.optional(), freeVcpu: boundedResource.optional(), freeMemoryBytes: boundedResource.optional(), freeStorageBytes: boundedResource.optional(), activeLeases: z.array(z.string().uuid()).optional(), preserveLeases: z.boolean().optional() }).strict();
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
export const PendingWorkerRequest = WorkerBootstrapRequest.omit({ code: true, encryptionPublicKey: true }).extend({ limits: WorkerLimits.nullable(), guestPlatforms: WorkerGuestPlatforms.optional(), admissionState: WorkerState.default("pending"), connectionState: ConnectionState.default("offline"), configurationState: ConfigurationState.default("unconfigured") });
export type PendingWorkerRequest = z.infer<typeof PendingWorkerRequest>;
export const ApproveWorkerRequest = z.object({ limits: WorkerLimits }).strict();
export type ApproveWorkerRequest = z.infer<typeof ApproveWorkerRequest>;

export const BrowserInvalidation = z.object({ version: z.literal(1), sequence: positiveSafe, organizationId: z.string(), type: z.literal("invalidate"), keys: z.array(z.array(z.unknown())), occurredAt: z.string().datetime() });
export type ConnectionState = z.infer<typeof ConnectionState>;
export type ConfigurationState = z.infer<typeof ConfigurationState>;
export type WorkerDoctorData = z.infer<typeof WorkerDoctorData>;
export type WorkerCapacityData = z.infer<typeof WorkerCapacityData>;
export { positiveSafe };
export type WorkerCommand = z.infer<typeof WorkerCommand>;
export type WorkerEvent = z.infer<typeof WorkerEvent>;
export type BrowserInvalidation = z.infer<typeof BrowserInvalidation>;