import { ANY_RUNNER_LABEL, ANY_X64_RUNNER_LABEL, parseJobRunnerLabels, PoolResources, type ParsedRunnerLabel, WorkerLimits, supportsExclusiveCpuPlacement } from "@mars/contracts";

export interface Candidate {
  worker: { admissionState:string; connectionState:string; configurationState:string; configurationRevision:string|null; appliedConfigurationRevision:string|null; runtimeReady?: boolean; imageEvidenceReady?: boolean; acceptingLeases?: boolean; limits: unknown; hostPlatform?: string; contractVersion?: string | null; availableCpuIds?: number[]; claimedCpuIds?: number[]; unreapedLeases?: number; modeConflict?: boolean };
  pool: { enabled:boolean; platform:string; resources:unknown; concurrency:number; active:number; labels:string[]; triggerLabel:string|null; cpuMode?: "shared" | "exclusive" };
  requestedLabels:string[];
}

export function selectProvisionOption(
  options: readonly ParsedRunnerLabel[],
  pool: { platform: string; labels: string[]; triggerLabel: string | null },
): ParsedRunnerLabel | null {
  const trigger = pool.triggerLabel?.trim().toLowerCase();
  if (trigger) {
    const exact = options.find((option) => option.route.toLowerCase() === trigger);
    if (exact) return exact;
  }
  const platform = pool.platform.trim().toLowerCase();
  if (platform.endsWith("-x64")) {
    const x64 = options.find((option) => option.route.toLowerCase() === ANY_X64_RUNNER_LABEL);
    if (x64) return x64;
  }
  return options.find((option) => option.route.toLowerCase() === ANY_RUNNER_LABEL) ?? null;
}

function exclusiveAvailable(candidate: Candidate, vcpu: number, concurrency: number, maxConcurrentPods: number): boolean {
  if (candidate.worker.modeConflict) return false;
  if (candidate.pool.cpuMode !== "exclusive") return true;
  if (!supportsExclusiveCpuPlacement(candidate.worker.contractVersion)) return false;
  if (!candidate.worker.hostPlatform?.startsWith("linux-")) return concurrency === 1 && maxConcurrentPods === 1 && (candidate.worker.unreapedLeases ?? 0) === 0;
  const inventory = candidate.worker.availableCpuIds;
  if (!inventory?.length || inventory.some((id, index) => !Number.isInteger(id) || id < 0 || index > 0 && id <= inventory[index - 1]!)) return false;
  const claimed = new Set(candidate.worker.claimedCpuIds ?? []);
  return inventory.reduce((count, id) => count + Number(!claimed.has(id)), 0) >= vcpu;
}
export function fits(candidate: Candidate): boolean {
  const options = parseJobRunnerLabels(candidate.requestedLabels)?.options;
  if (!options) return false;
  const option = selectProvisionOption(options, candidate.pool);
  if (!option) return false;
  if (candidate.worker.admissionState !== "adopted" || candidate.worker.connectionState !== "online" || candidate.worker.configurationState !== "ready" || candidate.worker.configurationRevision !== candidate.worker.appliedConfigurationRevision || candidate.worker.runtimeReady !== true || candidate.worker.imageEvidenceReady === false || candidate.worker.acceptingLeases === false || !candidate.pool.enabled) return false;
  const limits = WorkerLimits.safeParse(candidate.worker.limits);
  const resources = PoolResources.safeParse(candidate.pool.resources);
  if (!limits.success || !resources.success || candidate.pool.active >= resources.data.concurrency) return false;
  return exclusiveAvailable(candidate, option.vcpu, resources.data.concurrency, limits.data.maxConcurrentPods) && option.vcpu <= limits.data.maxVcpuPerPod && option.memoryBytes <= limits.data.maxMemoryBytesPerPod && resources.data.storageBytes <= limits.data.maxStorageBytesPerPod;
}

export function reason(candidate: Candidate): string {
  const options = parseJobRunnerLabels(candidate.requestedLabels)?.options;
  if (!options) return "invalid_provision_labels";
  const option = selectProvisionOption(options, candidate.pool);
  if (!option) return "no_matching_labels";
  if (candidate.worker.connectionState !== "online") return "worker_offline";
  if (candidate.worker.configurationState === "applying" || (candidate.worker.configurationState === "ready" && candidate.worker.configurationRevision !== candidate.worker.appliedConfigurationRevision)) return "worker_config_applying";
  if (candidate.worker.configurationState !== "ready") return "worker_not_ready";
  if (candidate.worker.runtimeReady !== true || candidate.worker.imageEvidenceReady === false) return "worker_runtime_not_ready";
  if (candidate.worker.acceptingLeases === false) return "worker_pickup_paused";
  if (!candidate.pool.enabled) return "pool_disabled";
  const resources = PoolResources.safeParse(candidate.pool.resources);
  const limits = WorkerLimits.safeParse(candidate.worker.limits);
  if (!resources.success || !limits.success) return "resource_ceiling";
  if (candidate.pool.active >= resources.data.concurrency) return "pool_concurrency";
  if (!exclusiveAvailable(candidate, option.vcpu, resources.data.concurrency, limits.data.maxConcurrentPods)) return "exclusive_capacity_unavailable";
  return option.vcpu <= limits.data.maxVcpuPerPod && option.memoryBytes <= limits.data.maxMemoryBytesPerPod && resources.data.storageBytes <= limits.data.maxStorageBytesPerPod ? "admissible" : "resource_ceiling";
}
