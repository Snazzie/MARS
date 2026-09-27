import { ANY_RUNNER_LABEL, ANY_X64_RUNNER_LABEL, parseJobRunnerLabels, PoolResources, type ParsedRunnerLabel, WorkerLimits, supportsExclusiveCpuPlacement } from "@mars/contracts";

export interface Candidate {
  worker: { admissionState:string; connectionState:string; configurationState:string; configurationRevision:string|null; appliedConfigurationRevision:string|null; runtimeReady?: boolean; imageEvidenceReady?: boolean; acceptingLeases?: boolean; limits: unknown; hostPlatform?: string; contractVersion?: string | null; availableCpuIds?: number[]; claimedCpuIds?: number[]; unreapedLeases?: number; modeConflict?: boolean };
  pool: { enabled:boolean; platform:string; resources:unknown; concurrency:number; active:number; labels:string[]; triggerLabel:string|null; cpuMode?: "shared" | "exclusive" };
  requestedLabels:string[];
}


export function orderCandidatesByLoad<T extends Candidate & { worker: Candidate["worker"] & { id: string }; pool: Candidate["pool"] & { id: string } }>(
  candidates: readonly T[],
  jobId: number,
  reservedByPool: ReadonlyMap<string, number>,
): T[] {
  const load = (candidate: T) => candidate.pool.active + (reservedByPool.get(`${candidate.pool.id}:${candidate.worker.id}`) ?? 0);
  return candidates.map((_, index) => candidates[(jobId + index) % candidates.length]!).sort((left, right) => load(left) - load(right));
}
const OS_FAMILY_ROUTE = /^mars-(ubuntu|windows|macos)(?:-(x64|arm64))?$/;

function matchesOsPlatform(route: string, platform: string): boolean {
  const match = OS_FAMILY_ROUTE.exec(route);
  if (!match) return true;
  const family = match[1] === "ubuntu" ? "linux" : match[1];
  return platform.startsWith(`${family}-`) && (!match[2] || platform === `${family}-${match[2]}`);
}

export function selectProvisionOption(
  options: readonly ParsedRunnerLabel[],
  pool: { platform: string; labels: string[]; triggerLabel: string | null },
): ParsedRunnerLabel | null {
  const platform = pool.platform.trim().toLowerCase();
  const trigger = pool.triggerLabel?.trim().toLowerCase();
  if (trigger) {
    const exact = options.find(option => option.route === trigger && matchesOsPlatform(option.route, platform));
    if (exact) return exact;
  }
  const alias = options.find(option => matchesOsPlatform(option.route, platform) && pool.labels.some(label => label.startsWith("mars-") && label.toLowerCase() === option.route));
  if (alias) return alias;
  const family = options.find(option => OS_FAMILY_ROUTE.test(option.route) && matchesOsPlatform(option.route, platform));
  if (family) return family;
  if (platform.endsWith("-x64")) {
    const x64 = options.find((option) => option.route === ANY_X64_RUNNER_LABEL);
    if (x64) return x64;
  }
  return options.find((option) => option.route === ANY_RUNNER_LABEL) ?? null;
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
