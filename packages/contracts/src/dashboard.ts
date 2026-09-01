import { z } from "zod";
import { positiveSafe, OutOfMemoryResult, PoolResources, RuntimeDriverName, RuntimePlatform, WorkerLimits, GuestPlatform, ConfigurationState } from "./orchestration.ts";

const id = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, "Invalid cursor");
const secretKey = /(secret|token|password|private.?key|encoded.?jit|jit.?config|credential|join.?code|claim)/i;

function rejectSecrets(value: unknown, path: (string | number)[] = []): string | undefined {
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) { const error = rejectSecrets(value[i], [...path, i]); if (error) return error; }
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (secretKey.test(key)) return `Secret-like key is not permitted: ${[...path, key].join(".")}`;
    const error = rejectSecrets(child, [...path, key]); if (error) return error;
  }
  return undefined;
}
function dto<T extends z.ZodTypeAny>(schema: T): T { return schema.superRefine((value, ctx) => { const error = rejectSecrets(value); if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error }); }) as unknown as T; }
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const organizationId = id;
const resources = PoolResources;

export const RunStage = z.enum(["queued", "allocating", "sandbox_ready", "agent_call_home", "runner_online", "running", "completed", "failed", "reaping", "reaped"]);
export type RunStage = z.infer<typeof RunStage>;
export const OrganizationSummary = dto(strict({ id, name: z.string().min(1), login: z.string().min(1), role: z.enum(["owner", "admin", "member"]), repositoryCount: positiveSafe.or(z.literal(0)), workerCount: positiveSafe.or(z.literal(0)) }));
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;
export const OverviewTimeseriesPoint = dto(strict({ bucket: timestamp, pending: positiveSafe.or(z.literal(0)), running: positiveSafe.or(z.literal(0)) }));
export type OverviewTimeseriesPoint = z.infer<typeof OverviewTimeseriesPoint>;
const OverviewJobOutcome = z.enum(["queued", "running", "completed", "failed"]);
const OverviewJobOutcomePlatforms = strict({ macos: positiveSafe.or(z.literal(0)), ubuntu: positiveSafe.or(z.literal(0)), windows: positiveSafe.or(z.literal(0)), other: positiveSafe.or(z.literal(0)) });
const nonnegativeSafe = z.number().int().nonnegative().safe();
export const OverviewRunningContainer = dto(strict({ id, jobId: id, jobName: z.string().min(1), repositoryName: z.string().min(1), workflowName: z.string().min(1), workerName: z.string().min(1), runtime: z.string().min(1), startedAt: timestamp, cpuUsagePercent: z.number().min(0).max(100).nullable(), memoryWorkingSetBytes: nonnegativeSafe.nullable(), memoryLimitBytes: positiveSafe.nullable(), diskUsageBytes: nonnegativeSafe.nullable(), allocatedStorageBytes: nonnegativeSafe, sampledAt: timestamp.nullable() }));
export type OverviewRunningContainer = z.output<typeof OverviewRunningContainer>;
export const OverviewDto = dto(strict({ organizationId, period: z.enum(["24h", "7d", "30d"]), queued: positiveSafe.or(z.literal(0)), running: positiveSafe.or(z.literal(0)), completed: positiveSafe.or(z.literal(0)), failed: positiveSafe.or(z.literal(0)), queueP50Ms: positiveSafe.or(z.literal(0)), queueP95Ms: positiveSafe.or(z.literal(0)), durationP50Ms: positiveSafe.or(z.literal(0)), durationP95Ms: positiveSafe.or(z.literal(0)), concurrency: positiveSafe.or(z.literal(0)), utilization: strict({ vcpu: z.number().min(0).max(1), memory: z.number().min(0).max(1), storage: z.number().min(0).max(1), pods: z.number().min(0).max(1) }), timeseries: z.array(OverviewTimeseriesPoint).default([]), jobOutcomes: z.array(strict({ outcome: OverviewJobOutcome, platforms: OverviewJobOutcomePlatforms })).default([]), runningContainers: z.array(OverviewRunningContainer).default([]) }));
export type OverviewDto = z.output<typeof OverviewDto>;
export const RepositorySummary = dto(strict({ id, organizationId, name: z.string().min(1), fullName: z.string().min(1), visibility: z.enum(["private", "internal", "public"]), available: z.boolean(), installationId: id, discoveryState: z.enum(["active", "paused", "rate_limited", "queued"]), discoveryRetryAt: timestamp.nullable() }));
export type RepositorySummary = z.infer<typeof RepositorySummary>;
const runSummaryShape = { id, organizationId, repositoryId: id, repositoryName: z.string().min(1), runNumber: positiveSafe, workflowName: z.string().min(1), event: z.string().min(1), branch: z.string().min(1), commitSha: z.string().regex(/^[0-9a-f]{7,64}$/i), actorLogin: z.string().min(1), status: z.enum(["queued", "in_progress", "completed"]), conclusion: z.enum(["success", "failure", "cancelled", "skipped", "neutral"]).nullable(), queuedAt: timestamp, startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), durationMs: positiveSafe.or(z.literal(0)), runtimeBoundary: z.enum(["Kata VM-backed container", "Hyper-V isolated container", "Tart VM"]).nullable(), allocationState: z.enum(["mars", "external"]).optional() };
export const RunSummary = dto(strict(runSummaryShape));
export type RunSummary = z.infer<typeof RunSummary>;
export const RunnerTriggerLabel = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/).refine((label) => !["self-hosted", "linux", "windows", "macos", "x64", "arm64"].includes(label));
export type RunnerTriggerLabel = z.infer<typeof RunnerTriggerLabel>;
export const CreatePoolRequest = dto(strict({ poolId: id.optional(), workerId: id, name: z.string().min(1), guestPlatform: GuestPlatform.default("macos-arm64"), resources, triggerLabel: RunnerTriggerLabel, imageDigest: z.string().regex(/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/) }));
export type CreatePoolRequest = z.infer<typeof CreatePoolRequest>;
export const RunStep = dto(strict({ id, name: z.string().min(1), number: z.number().int().nonnegative(), status: z.enum(["queued", "in_progress", "completed"]), conclusion: z.string().nullable(), queuedAt: timestamp, startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), durationMs: positiveSafe.or(z.literal(0)) }));
export type RunStep = z.infer<typeof RunStep>;
export const RunJob = dto(strict({ id, name: z.string().min(1), status: z.enum(["queued", "in_progress", "completed"]), conclusion: z.string().nullable(), stage: RunStage, runnerName: z.string().nullable(), logsState: z.enum(["pending", "ingested", "unavailable"]), requested: resources, requestedLabels: z.array(z.string().min(1)), observed: resources.nullable(), failureReason: z.enum(["out_of_memory", "runner_lost", "runner_failed"]).nullable().optional(), oom: OutOfMemoryResult.nullable().optional(), steps: z.array(RunStep) }));
export type RunJob = z.infer<typeof RunJob>;
export const ActionGraph = dto(strict({ nodes: z.array(strict({ id, name: z.string().min(1), status: RunStage })), edges: z.array(strict({ from: id, to: id })) }));
export type ActionGraph = z.infer<typeof ActionGraph>;
export const RunStageRecord = dto(strict({ stage: RunStage, startedAt: timestamp, completedAt: timestamp.nullable(), durationMs: positiveSafe.or(z.literal(0)) }));
export type RunStageRecord = z.infer<typeof RunStageRecord>;
export const RunDetail = dto(strict({ ...runSummaryShape, jobs: z.array(RunJob), stages: z.array(RunStageRecord), actionGraph: ActionGraph }));
export type RunDetail = z.infer<typeof RunDetail>;
const timingDuration = positiveSafe.or(z.literal(0));
const timingOutcome = z.enum(["success", "failure", "cancelled", "skipped", "neutral"]);
export const JobTimingSnapshot = dto(strict({
  organizationId: id, jobId: id, runId: id, repositoryId: id, githubJobId: positiveSafe,
  repositoryName: z.string().min(1), workflowName: z.string().min(1), jobName: z.string().min(1),
  platform: z.string().min(1), driver: z.string().min(1), runtimeBoundary: z.string().nullable(),
  poolId: id.nullable(), artifactDigest: z.string().nullable(), outcome: timingOutcome,
  completedAt: timestamp, queuedAt: timestamp, startedAt: timestamp.nullable(),
  queueDurationMs: timingDuration, startupDurationMs: timingDuration, executionDurationMs: timingDuration,
  cleanupDurationMs: timingDuration, totalDurationMs: timingDuration,
  requestedVcpu: positiveSafe, requestedMemoryBytes: positiveSafe, requestedStorageBytes: positiveSafe,
  requestedConcurrency: positiveSafe, observedVcpu: positiveSafe.nullable(), observedMemoryBytes: positiveSafe.nullable(),
  observedStorageBytes: positiveSafe.nullable(), effectiveConcurrency: positiveSafe, telemetryState: z.enum(["available", "partial", "unavailable"]), telemetrySampleCount: positiveSafe.or(z.literal(0)), cpuAveragePercent: z.number().min(0).max(100).nullable(), cpuP50Percent: z.number().min(0).max(100).nullable(), cpuP95Percent: z.number().min(0).max(100).nullable(), cpuPeakPercent: z.number().min(0).max(100).nullable(), cpuTimeMs: timingDuration.nullable(), memoryAverageBytes: positiveSafe.nullable(), memoryPeakBytes: positiveSafe.nullable(), createdAt: timestamp,
}));
export type JobTimingSnapshot = z.infer<typeof JobTimingSnapshot>;
export const JobTimingAggregate = dto(strict({
  group: z.record(z.string(), z.string()), sampleCount: positiveSafe,
  minMs: timingDuration, maxMs: timingDuration, p50Ms: timingDuration, p95Ms: timingDuration,
}));
export type JobTimingAggregate = z.infer<typeof JobTimingAggregate>;
export const JobResourceSample = dto(strict({ organizationId: id, runId: id, jobId: id, leaseId: id, occurredAt: timestamp, cpuUsagePercent: z.number().min(0).max(100), cpuTimeMs: positiveSafe.or(z.literal(0)), memoryWorkingSetBytes: positiveSafe.or(z.literal(0)), memoryLimitBytes: positiveSafe }));
export type JobResourceSample = z.infer<typeof JobResourceSample>;
export const LogChunk = dto(strict({ organizationId, runId: id, jobId: id, sequence: positiveSafe.or(z.literal(0)), content: z.string(), hasMore: z.boolean(), occurredAt: timestamp }));
export type LogChunk = z.infer<typeof LogChunk>;
export const WorkerDoctor = dto(strict({ nestedKvm: z.boolean().optional(), kvmModules: z.boolean().optional(), versions: strict({ k3s: z.string(), kata: z.string(), containerd: z.string() }).optional(), runtimeHandler: z.string().optional(), runtimeMode: z.enum(["container", "vm", "tart"]).optional(), artifactSource: z.enum(["worker_local", "registry", "template"]).optional(), artifactIdentity: z.string().min(1).optional(), artifactDigest: z.string().regex(/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/).optional(), runtimeReady: z.boolean().optional(), runtimeBuildState: z.enum(["idle", "building", "ready", "failed"]).optional(), runtimeBuildMessage: z.string().max(1000).nullable().optional(), remediation: z.string().nullable().optional(), probe: z.boolean().optional(), egress: z.boolean().optional(), imageSignatures: z.boolean().optional(), blockVolume: z.boolean().optional(), activeLeases: z.array(id).optional(), preserveLeases: z.boolean().optional() }));
export type WorkerDoctor = z.infer<typeof WorkerDoctor>;
export const CapacitySnapshot = dto(strict({ vcpu: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }), memoryBytes: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }), storageBytes: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }), pods: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }) }));
export type CapacitySnapshot = z.infer<typeof CapacitySnapshot>;
export const WorkerCacheSummary = dto(strict({ desiredTtlSeconds: positiveSafe, desiredRunnerCacheEnabled: z.boolean().default(true), desiredRunnerCacheMaxGiB: positiveSafe.default(20), effectiveTtlSeconds: positiveSafe.nullable(), ready: z.boolean(), proxyOrigin: z.string().url().nullable(), cacheBaseUrl: z.string().url().nullable(), sizeBytes: z.string().regex(/^(?:0|[1-9]\d*)$/), entryCount: nonnegativeSafe, observedAt: timestamp.nullable(), error: z.string().max(1000).nullable() }));
export type WorkerCacheSummary = z.infer<typeof WorkerCacheSummary>;
const nonnegativeSafeNumber = z.number().nonnegative().safe();
const decimalBytes = z.string().regex(/^(?:0|[1-9]\d*)$/);
const workerHealthMetric = strict({ actual: nonnegativeSafeNumber, reserved: nonnegativeSafeNumber, free: nonnegativeSafeNumber });

export const WorkerHealthConnection = dto(strict({
  state: z.enum(["offline", "online"]),
  lastHeartbeatAt: timestamp.nullable(),
  lastDoctorAt: timestamp.nullable(),
  heartbeatAgeSeconds: nonnegativeSafe.nullable(),
  doctorAgeSeconds: nonnegativeSafe.nullable(),
}));
export type WorkerHealthConnection = z.infer<typeof WorkerHealthConnection>;

export const WorkerHealthUsage = dto(strict({
  cpu: workerHealthMetric,
  memoryBytes: strict({ actual: decimalBytes, reserved: decimalBytes, free: decimalBytes }),
  storageBytes: strict({ actual: decimalBytes, reserved: decimalBytes, free: decimalBytes }),
  pods: workerHealthMetric,
}));
export type WorkerHealthUsage = z.infer<typeof WorkerHealthUsage>;

export const WorkerHealthCache = dto(strict({
  desiredTtlSeconds: positiveSafe,
  effectiveTtlSeconds: positiveSafe.nullable(),
  ready: z.boolean(),
  generation: z.string().uuid().nullable(),
  sizeBytes: decimalBytes,
  entryCount: nonnegativeSafe,
  observedAt: timestamp.nullable(),
  error: z.string().max(1000).nullable(),
}));
export type WorkerHealthCache = z.infer<typeof WorkerHealthCache>;

export const WorkerHealthJobRequest = strict({
  vcpu: nonnegativeSafeNumber,
  memoryBytes: decimalBytes,
  storageBytes: decimalBytes,
  concurrency: nonnegativeSafeNumber,
});
export type WorkerHealthJobRequest = z.infer<typeof WorkerHealthJobRequest>;

export const WorkerHealthJob = dto(strict({
  jobId: nonnegativeSafe.nullable(),
  repositoryFullName: z.string().min(1).nullable(),
  repositoryName: z.string().min(1).nullable(),
  leaseId: z.string().uuid(),
  state: z.string().min(1),
  startedAt: timestamp.nullable(),
  ageSeconds: nonnegativeSafe.nullable(),
  requested: WorkerHealthJobRequest,
}));
export type WorkerHealthJob = z.infer<typeof WorkerHealthJob>;
const workerHealthContainerId = z.string().regex(/^[0-9a-f]{64}$/);
const workerHealthContainerState = z.enum(["created", "running", "paused", "restarting", "removing", "exited", "dead"]);
export const WorkerHealthContainer = dto(strict({
  containerId: workerHealthContainerId,
  name: z.string().min(1),
  leaseId: z.string().uuid(),
  state: workerHealthContainerState,
  cpuUsagePercent: z.number().min(0).max(100).nullable(),
  memoryWorkingSetBytes: decimalBytes.nullable(),
  memoryLimitBytes: decimalBytes.nullable(),
  diskUsageBytes: decimalBytes.nullable(),
  sampledAt: timestamp,
}));
export type WorkerHealthContainer = z.infer<typeof WorkerHealthContainer>;

export const WorkerHealth = dto(strict({
  observedAt: timestamp.nullable(),
  connection: WorkerHealthConnection,
  usage: WorkerHealthUsage,
  cache: WorkerHealthCache,
  containers: z.array(WorkerHealthContainer),
  jobs: z.array(WorkerHealthJob),
}));
export type WorkerHealth = z.infer<typeof WorkerHealth>;
export const DashboardWorkerCacheEntry = dto(strict({ entryId: id, githubRepositoryId: z.string().regex(/^(?:0|[1-9]\d*)$/), repositoryFullName: z.string().min(1).nullable(), repositoryUrl: z.string().url().nullable(), cacheKeyPreview: z.string().max(160), cacheKeyHash: z.string().regex(/^[0-9a-f]{64}$/), scopePreview: z.string().max(160), scopeHash: z.string().regex(/^[0-9a-f]{64}$/), versionHash: z.string().regex(/^[0-9a-f]{64}$/), sizeBytes: z.string().regex(/^(?:0|[1-9]\d*)$/), createdAt: timestamp, lastAccessedAt: timestamp, expiresAt: timestamp }));
export type DashboardWorkerCacheEntry = z.infer<typeof DashboardWorkerCacheEntry>;
export const DashboardWorkerCachePage = dto(strict({ items: z.array(DashboardWorkerCacheEntry), nextCursor: cursor.nullable() }));
export type DashboardWorkerCachePage = z.infer<typeof DashboardWorkerCachePage>;
export const WorkerDetail = dto(strict({ id, organizationId: organizationId.nullable(), name: z.string().min(1), platform: RuntimePlatform, guestPlatforms: z.array(GuestPlatform).min(1), driver: RuntimeDriverName, admissionState: z.enum(["pending", "adopted", "rejected", "revoked"]), connectionState: z.enum(["offline", "online"]), configurationState: ConfigurationState, configurationRevision: z.string().nullable(), appliedConfigurationRevision: z.string().nullable(), configurationAppliedAt: timestamp.nullable(), lastHeartbeatAt: timestamp.nullable(), lastDoctorAt: timestamp.nullable(), runtimeMode: z.enum(["container", "vm", "tart"]).nullable(), artifactDigest: z.string().nullable(), fingerprint: z.string().min(1), limits: WorkerLimits.nullable(), doctor: WorkerDoctor.nullable(), capacity: CapacitySnapshot, activeSandboxes: positiveSafe.or(z.literal(0)), draining: z.boolean(), preserveLeases: z.boolean().optional(), cache: WorkerCacheSummary.optional() }));
export type WorkerDetail = z.infer<typeof WorkerDetail>;
export const PoolSummary = dto(strict({ id, organizationId: id.nullable(), workerId: id.nullable(), workerName: z.string().min(1).nullable(), name: z.string().min(1), platform: RuntimePlatform, driver: RuntimeDriverName, imageDigest: z.string().min(1), resources, labels: z.array(z.string().min(1)), triggerLabel: RunnerTriggerLabel.nullable(), enabled: z.boolean(), active: positiveSafe.or(z.literal(0)) }));
export type PoolSummary = z.infer<typeof PoolSummary>;
export const OrganizationSettings = dto(strict({ organizationId, maxVcpuPerPod: positiveSafe, maxMemoryBytesPerPod: positiveSafe, maxStorageBytesPerPod: positiveSafe, maxConcurrentPods: positiveSafe }));
export type OrganizationSettings = z.infer<typeof OrganizationSettings>;
export const CursorPage = <T extends z.ZodTypeAny>(item: T) => dto(strict({ items: z.array(item), nextCursor: cursor.nullable() }));
export type CursorPage<T> = { items: T[]; nextCursor: string | null };
export const ApiError = dto(strict({ code: z.string().min(1), message: z.string().min(1), requestId: id, details: z.record(z.unknown()).optional() }));
export type ApiError = z.infer<typeof ApiError>;
export const RunnerWorkflowJobPreview = dto(strict({ id: z.string().min(1), currentRunsOn: z.union([z.string().min(1), z.array(z.string().min(1))]), proposedRunsOn: z.array(z.string().min(1)), path: z.string().regex(/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/) }));
export const RunnerWorkflowFile = dto(strict({ path: z.string().regex(/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/), jobs: z.array(strict({ id: z.string().min(1), currentRunsOn: z.union([z.string().min(1), z.array(z.string().min(1))]) })) }));
export type RunnerWorkflowFile = z.infer<typeof RunnerWorkflowFile>;
export const RunnerWorkflowPreview = dto(strict({ files: z.array(RunnerWorkflowFile).optional(), labels: z.array(z.string().min(1)), defaultBranch: z.string().min(1), headSha: z.string().min(1), changedFiles: z.array(z.string()), jobs: z.array(RunnerWorkflowJobPreview), replacementCount: z.number().int().nonnegative(), noOp: z.boolean() }));
export type RunnerWorkflowPreview = z.infer<typeof RunnerWorkflowPreview>;
export const RunnerWorkflowPrRequest = dto(strict({ selectedPaths: z.array(z.string().regex(/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/)), expectedHeadSha: z.string().regex(/^[0-9a-f]{7,64}$/i), title: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(10000).optional() }));
export type RunnerWorkflowPrRequest = z.infer<typeof RunnerWorkflowPrRequest>;
export const RunnerWorkflowPrResult = dto(strict({ url: z.string().url(), number: z.number().int().positive(), branch: z.string().min(1), changedFiles: z.array(z.string()), replacementCount: z.number().int().nonnegative() }));
export type RunnerWorkflowPrResult = z.infer<typeof RunnerWorkflowPrResult>;
export { WorkerBootstrapRequest, PendingWorkerRequest, ApproveWorkerRequest } from "./orchestration.ts";
export type { WorkerBootstrapRequest as WorkerBootstrapRequestData, PendingWorkerRequest as PendingWorkerRequestData, ApproveWorkerRequest as ApproveWorkerRequestData } from "./orchestration.ts";
