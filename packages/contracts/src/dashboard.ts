import { z } from "zod";
import { positiveSafe, PoolResources, RuntimeDriverName, RuntimePlatform, WorkerLimits } from "./orchestration.ts";

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
export const OverviewDto = dto(strict({ organizationId, period: z.enum(["24h", "7d", "30d"]), queued: positiveSafe.or(z.literal(0)), running: positiveSafe.or(z.literal(0)), completed: positiveSafe.or(z.literal(0)), failed: positiveSafe.or(z.literal(0)), queueP50Ms: positiveSafe.or(z.literal(0)), queueP95Ms: positiveSafe.or(z.literal(0)), durationP50Ms: positiveSafe.or(z.literal(0)), durationP95Ms: positiveSafe.or(z.literal(0)), concurrency: positiveSafe.or(z.literal(0)), utilization: strict({ vcpu: z.number().min(0).max(1), memory: z.number().min(0).max(1), storage: z.number().min(0).max(1), pods: z.number().min(0).max(1) }) }));
export type OverviewDto = z.infer<typeof OverviewDto>;
export const RepositorySummary = dto(strict({ id, organizationId, name: z.string().min(1), fullName: z.string().min(1), private: z.boolean(), installationId: id, approved: z.boolean() }));
export type RepositorySummary = z.infer<typeof RepositorySummary>;
const runSummaryShape = { id, organizationId, repositoryId: id, repositoryName: z.string().min(1), runNumber: positiveSafe, workflowName: z.string().min(1), event: z.string().min(1), branch: z.string().min(1), commitSha: z.string().regex(/^[0-9a-f]{7,64}$/i), actorLogin: z.string().min(1), status: z.enum(["queued", "in_progress", "completed"]), conclusion: z.enum(["success", "failure", "cancelled", "skipped", "neutral"]).nullable(), queuedAt: timestamp, startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), durationMs: positiveSafe.or(z.literal(0)), runtimeBoundary: z.enum(["Kata VM-backed container", "Hyper-V isolated container", "Tart VM"]).nullable() };
export const RunSummary = dto(strict(runSummaryShape));
export type RunSummary = z.infer<typeof RunSummary>;
export const RunJob = dto(strict({ id, name: z.string().min(1), status: z.enum(["queued", "in_progress", "completed"]), conclusion: z.string().nullable(), stage: RunStage, runnerName: z.string().nullable(), requested: resources, observed: resources.nullable() }));
export type RunJob = z.infer<typeof RunJob>;
export const ActionGraph = dto(strict({ nodes: z.array(strict({ id, name: z.string().min(1), status: RunStage })), edges: z.array(strict({ from: id, to: id })) }));
export type ActionGraph = z.infer<typeof ActionGraph>;
export const RunStageRecord = dto(strict({ stage: RunStage, startedAt: timestamp, completedAt: timestamp.nullable(), durationMs: positiveSafe.or(z.literal(0)) }));
export type RunStageRecord = z.infer<typeof RunStageRecord>;
export const RunDetail = dto(strict({ ...runSummaryShape, jobs: z.array(RunJob), stages: z.array(RunStageRecord), actionGraph: ActionGraph }));
export type RunDetail = z.infer<typeof RunDetail>;
export const LogChunk = dto(strict({ organizationId, runId: id, jobId: id, sequence: positiveSafe.or(z.literal(0)), content: z.string(), hasMore: z.boolean(), occurredAt: timestamp }));
export type LogChunk = z.infer<typeof LogChunk>;
export const WorkerDoctor = dto(strict({ nestedKvm: z.boolean(), kvmModules: z.boolean(), versions: strict({ k3s: z.string(), kata: z.string(), containerd: z.string() }), runtimeHandler: z.literal("kata-qemu-runtime-rs"), probe: z.boolean(), egress: z.boolean(), imageSignatures: z.boolean(), blockVolume: z.boolean(), remediation: z.string().nullable() }));
export type WorkerDoctor = z.infer<typeof WorkerDoctor>;
export const CapacitySnapshot = dto(strict({ vcpu: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }), memoryBytes: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }), storageBytes: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }), pods: strict({ actual: positiveSafe, reserved: positiveSafe.or(z.literal(0)), free: positiveSafe.or(z.literal(0)) }) }));
export type CapacitySnapshot = z.infer<typeof CapacitySnapshot>;
export const WorkerDetail = dto(strict({ id, organizationId: organizationId.nullable(), name: z.string().min(1), platform: RuntimePlatform, driver: RuntimeDriverName, admissionState: z.enum(["pending", "adopted", "rejected", "revoked"]), connectionState: z.enum(["offline", "online"]), configurationState: z.enum(["unconfigured", "ready", "error"]), fingerprint: z.string().min(1), limits: WorkerLimits.nullable(), doctor: WorkerDoctor.nullable(), capacity: CapacitySnapshot, activeSandboxes: positiveSafe.or(z.literal(0)), draining: z.boolean() }));
export type WorkerDetail = z.infer<typeof WorkerDetail>;
export const PoolSummary = dto(strict({ id, organizationId, workerId: id, workerName: z.string().min(1), name: z.string().min(1), platform: RuntimePlatform, driver: RuntimeDriverName, imageDigest: z.string().min(1), resources, labels: z.array(z.string().min(1)), enabled: z.boolean(), active: positiveSafe.or(z.literal(0)) }));
export type PoolSummary = z.infer<typeof PoolSummary>;
export const OrganizationSettings = dto(strict({ organizationId, maxVcpuPerPod: positiveSafe, maxMemoryBytesPerPod: positiveSafe, maxStorageBytesPerPod: positiveSafe, maxConcurrentPods: positiveSafe }));
export type OrganizationSettings = z.infer<typeof OrganizationSettings>;
export const CursorPage = <T extends z.ZodTypeAny>(item: T) => dto(strict({ items: z.array(item), nextCursor: cursor.nullable() }));
export type CursorPage<T> = { items: T[]; nextCursor: string | null };
export const ApiError = dto(strict({ code: z.string().min(1), message: z.string().min(1), requestId: id, details: z.record(z.unknown()).optional() }));
export type ApiError = z.infer<typeof ApiError>;
export { WorkerBootstrapRequest, PendingWorkerRequest, ApproveWorkerRequest } from "./orchestration.ts";
export type { WorkerBootstrapRequest as WorkerBootstrapRequestData, PendingWorkerRequest as PendingWorkerRequestData, ApproveWorkerRequest as ApproveWorkerRequestData } from "./orchestration.ts";
