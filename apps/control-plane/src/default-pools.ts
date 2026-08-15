import type { Sql } from "postgres";
import type { GuestPlatform } from "@whitesmith/contracts";

type PoolDefaults = Partial<Record<GuestPlatform, string | undefined>>;

export async function ensureDefaultPools(db: Sql<{}>, images: PoolDefaults): Promise<void> {
  const [worker] = await db`select platform, guest_platforms as "guestPlatforms", limits from workers where admission_state='adopted' and configuration_state='ready' order by created_at asc limit 1`;
  if (!worker || !worker.limits) return;
  const guestPlatforms = (Array.isArray(worker.guestPlatforms) ? worker.guestPlatforms : [worker.platform]) as GuestPlatform[];
  const limits = typeof worker.limits === "string" ? JSON.parse(worker.limits) : worker.limits as { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
  const resources = { vcpu: limits.maxVcpuPerPod, memoryBytes: limits.maxMemoryBytesPerPod, storageBytes: limits.maxStorageBytesPerPod, concurrency: limits.maxConcurrentPods };
  for (const platform of guestPlatforms) {
    const imageDigest = images[platform];
    if (!imageDigest) continue;
    const label = `whitesmith-${platform}`;
    const driver = platform === "linux-x64" ? "kata-k3s" : platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm";
    const name = `default-${platform}`;
    await db`insert into runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) values (null,null,${name},${platform},${driver},${imageDigest},${JSON.stringify(resources)}::jsonb,${JSON.stringify([label])}::jsonb,${label},true) on conflict (name) where organization_id is null do update set platform=excluded.platform,driver=excluded.driver,image_digest=excluded.image_digest,resources=excluded.resources,labels=excluded.labels,trigger_label=excluded.trigger_label,enabled=true`;
  }
}
