import type { Sql } from "@mars/db";
import { runtimeDriverForPlatform, runtimeDriverForWorker, type GuestPlatform } from "@mars/contracts";
import { jsonParameter } from "@mars/db";
import { storedWorkerDoctor, storedWorkerRuntimeMode, workerPoolEvidence } from "./worker-evidence.ts";

type PoolDefaults = Partial<Record<GuestPlatform, string | undefined>>;
type WorkerLimits = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
const GIB = 1024 ** 3;

export function poolResourcesForLimits(limits: WorkerLimits, concurrency = limits.maxConcurrentPods) {
  return {
    vcpu: Math.min(4, limits.maxVcpuPerPod),
    memoryBytes: Math.min(6 * GIB, limits.maxMemoryBytesPerPod),
    storageBytes: Math.min(30 * GIB, limits.maxStorageBytesPerPod),
    concurrency,
  };
}

export function poolResourcesForWorkers(workers: WorkerLimits[]) {
  if (!workers.length) return null;
  const defaults = workers.map((worker) => poolResourcesForLimits(worker));
  return {
    vcpu: Math.min(...defaults.map(({ vcpu }) => vcpu)),
    memoryBytes: Math.min(...defaults.map(({ memoryBytes }) => memoryBytes)),
    storageBytes: Math.min(...defaults.map(({ storageBytes }) => storageBytes)),
    concurrency: workers.reduce((sum, worker) => sum + worker.maxConcurrentPods, 0),
  };
}

function guestPlatformsForWorker(worker: Record<string, unknown>): GuestPlatform[] {
  const value = worker.guestPlatforms;
  return (Array.isArray(value) ? value : [worker.platform]).filter((platform): platform is GuestPlatform => platform === "linux-x64" || platform === "linux-arm64" || platform === "windows-x64" || platform === "macos-arm64");
}

export async function ensureDefaultPools(db: Sql<{}>, images: PoolDefaults): Promise<void> {
  const workers = await db`select platform, guest_platforms as "guestPlatforms", limits, doctor from workers where admission_state='adopted' and configuration_state='ready' order by created_at asc`;
  const configuredWorkers = workers
    .map((worker) => ({ worker, limits: (typeof worker.limits === "string" ? JSON.parse(worker.limits) : worker.limits) as WorkerLimits, doctor: storedWorkerDoctor(worker.doctor) }))
    .filter(({ worker }) => worker.limits);
  if (!configuredWorkers.length) return;
  const guestPlatforms = [...new Set(configuredWorkers.flatMap(({ worker }) => guestPlatformsForWorker(worker)))];
  for (const platform of guestPlatforms) {
    let compatibleWorkers = configuredWorkers.filter(({ worker }) => guestPlatformsForWorker(worker).includes(platform));
    let driver = runtimeDriverForPlatform(platform);
    let imageDigest = images[platform];
    if (platform === "linux-arm64" || platform === "macos-arm64") {
      compatibleWorkers = compatibleWorkers.filter(({ worker }) => worker.platform === "macos-arm64");
      driver = "tart-vm";
      imageDigest = compatibleWorkers.map(({ doctor }) => (doctor.artifactDigests && typeof doctor.artifactDigests === "object" ? (doctor.artifactDigests as Record<string, unknown>)[platform] : undefined)).find((digest): digest is string => typeof digest === "string");
      if (imageDigest) compatibleWorkers = compatibleWorkers.filter(({ doctor }) => doctor.artifactDigests && typeof doctor.artifactDigests === "object" && (doctor.artifactDigests as Record<string, unknown>)[platform] === imageDigest);
    } else {
      if (platform === "windows-x64") driver = compatibleWorkers.some(({ doctor }) => doctor.runtimeMode !== "vm") ? "windows-hyperv-container" : "windows-hyperv";
      compatibleWorkers = compatibleWorkers.filter(({ worker, doctor }) => runtimeDriverForWorker(worker.platform, platform, storedWorkerRuntimeMode(doctor)) === driver);
      if (platform === "windows-x64") {
        imageDigest = compatibleWorkers.map(({ doctor }) => doctor.artifactDigest).find((digest): digest is string => typeof digest === "string");
        if (imageDigest) compatibleWorkers = compatibleWorkers.filter(({ doctor }) => { const evidence = workerPoolEvidence(doctor, driver, imageDigest!, platform); return evidence.ready && evidence.imageMatches; });
      }
    }
    const resources = poolResourcesForWorkers(compatibleWorkers.map(({ limits }) => limits));
    if (!resources || !imageDigest) continue;
    const label = `mars-${platform}`;
    const labels = platform === "linux-arm64" ? [label, "ubuntu"] : [label];
    const name = `default-${platform}`;
    const [existing] = await db`select id from runner_pools where organization_id is null and (name=${name} or trigger_label=${label}) limit 1`;
    if (existing) {
      await db`update runner_pools set worker_id=null,platform=${platform},driver=${driver},image_digest=${imageDigest},resources=${jsonParameter(db, resources)}::jsonb,labels=${jsonParameter(db, labels)}::jsonb,trigger_label=${label},enabled=true,name=${name} where id=${existing.id}`;
    } else {
      await db`insert into runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) values (null,null,${name},${platform},${driver},${imageDigest},${jsonParameter(db, resources)}::jsonb,${jsonParameter(db, labels)}::jsonb,${label},true)`;
    }
  }
}

