import type { Sql } from "@mars/db";
import { runtimeDriverForPlatform, type GuestPlatform } from "@mars/contracts";
import { jsonParameter } from "@mars/db";
import { storedWorkerDoctor, workerPoolEvidence } from "./worker-evidence.ts";

type PoolDefaults = Partial<Record<GuestPlatform, string | undefined>> & { ubuntuVersion?: "22" | "24" | "26" };
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
  const workers = await db`select platform, guest_platforms as "guestPlatforms", limits, doctor, desired_configuration as "desiredConfiguration", configuration_revision as "configurationRevision", applied_configuration_revision as "appliedConfigurationRevision" from workers where admission_state='adopted' and configuration_state='ready' and configuration_revision=applied_configuration_revision and doctor_observed_at>now()-interval '60 seconds' order by created_at asc`;
  const configuredWorkers = workers
    .map((worker) => ({ worker, limits: (typeof worker.limits === "string" ? JSON.parse(worker.limits) : worker.limits) as WorkerLimits, doctor: storedWorkerDoctor(worker.doctor), desired: typeof worker.desiredConfiguration === "string" ? JSON.parse(worker.desiredConfiguration) : worker.desiredConfiguration }))
    .filter(({ worker, limits, doctor, desired }) => worker.limits && Array.isArray(doctor.capabilities) && desired && typeof desired.selectedDriver === "string");
  const guestPlatforms: GuestPlatform[] = ["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"];
  for (const platform of guestPlatforms) {
    let choices = configuredWorkers.flatMap(({ worker, limits, doctor, desired }) => {
      const driver = String(desired.selectedDriver);
      return guestPlatformsForWorker(worker).includes(platform) && Array.isArray(doctor.capabilities)
        && doctor.capabilities.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).driver === driver && (item as Record<string, unknown>).guestPlatform === platform && (item as Record<string, unknown>).ready === true && typeof (item as Record<string, unknown>).imageDigest === "string")
        ? [{ worker, limits, doctor, driver }] : [];
    });
    let driver = runtimeDriverForPlatform(platform);
    let imageDigest: string | undefined = images[platform];
    if (platform === "windows-x64") {
      const order = ["windows-hyperv-container", "windows-hyperv", "windows-process-container"];
      choices.sort((a, b) => order.indexOf(a.driver) - order.indexOf(b.driver));
      if (choices[0]) driver = choices[0].driver as typeof driver;
    } else if (platform === "linux-x64") {
      const vm = choices.filter((choice) => choice.driver === "linux-libvirt-vm");
      const docker = choices.filter((choice) => choice.driver === "linux-docker-container" && choice.worker.platform === "windows-x64");
      choices = vm.length ? vm : docker;
      if (choices[0]) driver = choices[0].driver as typeof driver;
    } else {
      choices = choices.filter(({ worker }) => worker.platform !== "windows-x64");
      if ((platform === "linux-arm64" || platform === "macos-arm64") && choices.some(({ worker }) => worker.platform === "macos-arm64")) {
        choices = choices.filter(({ worker }) => worker.platform === "macos-arm64");
        driver = "tart-vm";
      }
    }
    choices = choices.filter((choice) => choice.driver === driver);
    if (driver === "tart-vm") {
      imageDigest = choices.map(({ doctor }) => {
        const cap = (doctor.capabilities as Record<string, unknown>[]).find((item) => item.driver === driver && item.guestPlatform === platform);
        return cap?.imageDigest;
      }).find((digest): digest is string => typeof digest === "string");
    } else {
      imageDigest = choices.map(({ doctor }) => {
        const cap = (doctor.capabilities as Record<string, unknown>[]).find((item) => item.driver === driver && item.guestPlatform === platform);
        return cap?.imageDigest;
      }).find((digest): digest is string => typeof digest === "string");
    }
    if (imageDigest) choices = choices.filter(({ doctor }) => workerPoolEvidence(doctor, driver, imageDigest!, platform).ready && workerPoolEvidence(doctor, driver, imageDigest!, platform).imageMatches);
    const resources = poolResourcesForWorkers(choices.map(({ limits }) => limits))
      ?? { vcpu: 4, memoryBytes: 6 * GIB, storageBytes: 30 * GIB, concurrency: 1 };
    const label = platform === "linux-x64" ? `mars-ubuntu-${images.ubuntuVersion ?? "24"}` : `mars-${platform}`;
    const labels = platform === "linux-arm64" ? [label, "ubuntu"] : [label];
    const name = `default-${platform}`;
    const enabled = Boolean(imageDigest && choices.length);
    const [existing] = await db`select id,driver,image_digest as "imageDigest",platform from runner_pools where organization_id is null and (name=${name} or trigger_label=${label}) limit 1`;
    if (existing) {
      const retained = configuredWorkers.filter(({ worker, doctor, desired }) => desired.selectedDriver === existing.driver && guestPlatformsForWorker(worker).includes(existing.platform as GuestPlatform) && workerPoolEvidence(doctor, String(existing.driver), String(existing.imageDigest), String(existing.platform)).ready && workerPoolEvidence(doctor, String(existing.driver), String(existing.imageDigest), String(existing.platform)).imageMatches);
      const retainedResources = poolResourcesForWorkers(retained.map(({ limits }) => limits)) ?? resources;
      await db`update runner_pools set resources=${jsonParameter(db, retainedResources)}::jsonb,enabled=${retained.length > 0} where id=${existing.id}`;
    } else {
      await db`insert into runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) values (null,null,${name},${platform},${driver},${imageDigest ?? ""},${jsonParameter(db, resources)}::jsonb,${jsonParameter(db, labels)}::jsonb,${label},${enabled})`;
    }
  }
}

