import type { Sql } from "postgres";
import type { GuestPlatform } from "@whitesmith/contracts";
import { jsonParameter } from "@whitesmith/db";

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
  return {
    vcpu: workers.reduce((sum, worker) => sum + worker.maxVcpuPerPod, 0),
    memoryBytes: workers.reduce((sum, worker) => sum + worker.maxMemoryBytesPerPod, 0),
    storageBytes: workers.reduce((sum, worker) => sum + worker.maxStorageBytesPerPod, 0),
    concurrency: workers.reduce((sum, worker) => sum + worker.maxConcurrentPods, 0),
  };
}

function guestPlatformsForWorker(worker: Record<string, unknown>): GuestPlatform[] {
  const value = worker.guestPlatforms;
  return (Array.isArray(value) ? value : [worker.platform]).filter((platform): platform is GuestPlatform => platform === "linux-x64" || platform === "windows-x64" || platform === "macos-arm64");
}

export async function ensureDefaultPools(db: Sql<{}>, images: PoolDefaults): Promise<void> {
  const workers = await db`select platform, guest_platforms as "guestPlatforms", limits from workers where admission_state='adopted' and configuration_state='ready' order by created_at asc`;
  const configuredWorkers = workers
    .map((worker) => ({ worker, limits: (typeof worker.limits === "string" ? JSON.parse(worker.limits) : worker.limits) as WorkerLimits }))
    .filter(({ worker }) => worker.limits);
  if (!configuredWorkers.length) return;
  const guestPlatforms = [...new Set(configuredWorkers.flatMap(({ worker }) => guestPlatformsForWorker(worker)))];
  for (const platform of guestPlatforms) {
    const compatibleWorkers = configuredWorkers.filter(({ worker }) => guestPlatformsForWorker(worker).includes(platform));
    const resources = poolResourcesForWorkers(compatibleWorkers.map(({ limits }) => limits));
    if (!resources) continue;
    const imageDigest = images[platform];
    if (!imageDigest) continue;
    const label = `whitesmith-${platform}`;
    const driver = platform === "linux-x64" ? "kata-k3s" : platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm";
    const name = `default-${platform}`;
    const [existing] = await db`select id from runner_pools where organization_id is null and (name=${name} or trigger_label=${label}) limit 1`;
    if (existing) {
      await db`update runner_pools set worker_id=null,platform=${platform},driver=${driver},image_digest=${imageDigest},resources=${jsonParameter(db, resources)}::jsonb,labels=${jsonParameter(db, [label])}::jsonb,trigger_label=${label},enabled=true,name=${name} where id=${existing.id}`;
    } else {
      await db`insert into runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) values (null,null,${name},${platform},${driver},${imageDigest},${jsonParameter(db, resources)}::jsonb,${jsonParameter(db, [label])}::jsonb,${label},true)`;
    }
  }
}

