import { PoolResources, WorkerLimits } from "@whitesmith/contracts";

export interface Candidate {
  worker: { admissionState:string; connectionState:string; configurationState:string; limits: unknown };
  pool: { enabled:boolean; resources:unknown; concurrency:number; active:number; labels:string[]; triggerLabel:string|null };
  requestedLabels:string[];
}

export type Provision = { routingLabels: string[]; vcpu?: number; memoryBytes?: number };

export function parseProvisionLabels(labels: readonly string[]): Provision | null {
  const routingLabels: string[] = [];
  let vcpu: number | undefined;
  let memoryBytes: number | undefined;
  for (const original of labels) {
    const label = original.trim();
    const lower = label.toLowerCase();
    const cpuCandidate = /^\d+vcpu$/.test(lower);
    const memoryCandidate = /^\d+g$/.test(lower);
    if (!cpuCandidate && !memoryCandidate) { routingLabels.push(original); continue; }
    if (cpuCandidate) {
      if (!/^[1-9]\d*vcpu$/.test(lower) || vcpu !== undefined) return null;
      const value = Number(lower.slice(0, -4));
      if (!Number.isSafeInteger(value) || value <= 0) return null;
      vcpu = value;
    } else {
      if (!/^[1-9]\d*g$/.test(lower) || memoryBytes !== undefined) return null;
      const value = Number(lower.slice(0, -1));
      if (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 3)) return null;
      memoryBytes = value * 1024 ** 3;
    }
  }
  return { routingLabels, ...(vcpu === undefined ? {} : { vcpu }), ...(memoryBytes === undefined ? {} : { memoryBytes }) };
}

export function resolveProvisionResources(poolResources: unknown, provision: Provision): PoolResources | null {
  const parsed = PoolResources.safeParse(poolResources);
  if (!parsed.success) return null;
  return PoolResources.safeParse({ ...parsed.data, ...(provision.vcpu === undefined ? {} : { vcpu: provision.vcpu }), ...(provision.memoryBytes === undefined ? {} : { memoryBytes: provision.memoryBytes }) }).success
    ? { ...parsed.data, ...(provision.vcpu === undefined ? {} : { vcpu: provision.vcpu }), ...(provision.memoryBytes === undefined ? {} : { memoryBytes: provision.memoryBytes }) }
    : null;
}

export function labelsMatch(requestedLabels: readonly string[], poolLabels: readonly string[], triggerLabel: string|null): boolean {
  if (!triggerLabel) return false;
  const requested = new Set(requestedLabels.map((label) => label.toLowerCase()));
  const labels = new Set(poolLabels.map((label) => label.toLowerCase()));
  return requested.has(triggerLabel.toLowerCase()) && [...requested].every((label) => labels.has(label));
}

export function fits(candidate: Candidate): boolean {
  const provision = parseProvisionLabels(candidate.requestedLabels);
  if (!provision || !labelsMatch(provision.routingLabels, candidate.pool.labels, candidate.pool.triggerLabel)) return false;
  if (candidate.worker.admissionState !== "adopted" || candidate.worker.connectionState !== "online" || candidate.worker.configurationState !== "ready" || !candidate.pool.enabled || candidate.pool.active >= candidate.pool.concurrency) return false;
  const limits = WorkerLimits.safeParse(candidate.worker.limits);
  const resources = resolveProvisionResources(candidate.pool.resources, provision);
  if (!limits.success || !resources) return false;
  return resources.vcpu <= limits.data.maxVcpuPerPod && resources.memoryBytes <= limits.data.maxMemoryBytesPerPod && resources.storageBytes <= limits.data.maxStorageBytesPerPod && resources.concurrency <= limits.data.maxConcurrentPods;
}

export function reason(candidate: Candidate): string {
  const provision = parseProvisionLabels(candidate.requestedLabels);
  if (!provision) return "invalid_provision_labels";
  if (!labelsMatch(provision.routingLabels, candidate.pool.labels, candidate.pool.triggerLabel)) return "no_matching_labels";
  if (candidate.worker.admissionState !== "adopted") return "worker_pending_adoption";
  if (candidate.worker.connectionState !== "online") return "worker_offline";
  if (candidate.worker.configurationState !== "ready") return "worker_not_ready";
  if (!candidate.pool.enabled) return "pool_disabled";
  if (candidate.pool.active >= candidate.pool.concurrency) return "pool_concurrency";
  const resources = resolveProvisionResources(candidate.pool.resources, provision);
  const limits = WorkerLimits.safeParse(candidate.worker.limits);
  return resources && limits.success && resources.vcpu <= limits.data.maxVcpuPerPod && resources.memoryBytes <= limits.data.maxMemoryBytesPerPod && resources.storageBytes <= limits.data.maxStorageBytesPerPod && resources.concurrency <= limits.data.maxConcurrentPods ? "admissible" : "resource_ceiling";
}
