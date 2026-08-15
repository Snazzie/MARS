import type { Sql } from "postgres";
import type { GuestPlatform } from "@whitesmith/contracts";

type PoolDefaults = Partial<Record<GuestPlatform, string | undefined>>;
type WorkerLimits = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
const GIB = 1024 ** 3;

export function poolResourcesForLimits(limits: WorkerLimits) {
  return {
    vcpu: Math.min(2, limits.maxVcpuPerPod),
    memoryBytes: Math.min(2 * GIB, limits.maxMemoryBytesPerPod),
    storageBytes: Math.min(10 * GIB, limits.maxStorageBytesPerPod),
    concurrency: Math.min(1, limits.maxConcurrentPods),
  };
}

export async function ensureDefaultPools(db: Sql<{}>, images: PoolDefaults): Promise<void> {
  const [worker] = await db`select platform, guest_platforms as "guestPlatforms", limits from workers where admission_state='adopted' and configuration_state='ready' order by created_at asc limit 1`;
  if (!worker || !worker.limits) return;
  const guestPlatforms = (Array.isArray(worker.guestPlatforms) ? worker.guestPlatforms : [worker.platform]) as GuestPlatform[];
  const limits = (typeof worker.limits === "string" ? JSON.parse(worker.limits) : worker.limits) as WorkerLimits;
  const resources = poolResourcesForLimits(limits);
  for (const platform of guestPlatforms) {
    const imageDigest = images[platform];
    if (!imageDigest) continue;
    const label = `whitesmith-${platform}`;
    const driver = platform === "linux-x64" ? "kata-k3s" : platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm";
    const name = `default-${platform}`;
    const [existing] = await db`select id from runner_pools where organization_id is null and (name=${name} or trigger_label=${label}) limit 1`;
    if (existing) {
      await db`update runner_pools set worker_id=null,platform=${platform},driver=${driver},image_digest=${imageDigest},resources=${JSON.stringify(resources)}::jsonb,labels=${JSON.stringify([label])}::jsonb,trigger_label=${label},enabled=true,name=${name} where id=${existing.id}`;
    } else {
      await db`insert into runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) values (null,null,${name},${platform},${driver},${imageDigest},${JSON.stringify(resources)}::jsonb,${JSON.stringify([label])}::jsonb,${label},true)`;
    }
  }
}
