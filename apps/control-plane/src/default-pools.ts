import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import { runtimeDriverForPlatform, type GuestPlatform } from "@mars/contracts";
import { storedWorkerDoctor, workerPoolEvidence } from "./worker-evidence.ts";

const queries = defineQueries(db => ({
  workers: db.select({
    platform: schema.workers.platform,
    guestPlatforms: schema.workers.guestPlatforms,
    limits: schema.workers.limits,
    doctor: schema.workers.doctor,
    desiredConfiguration: schema.workers.desiredConfiguration,
  }).from(schema.workers).where(and(
    eq(schema.workers.admissionState, "adopted"),
    eq(schema.workers.configurationState, "ready"),
    eq(schema.workers.configurationRevision, schema.workers.appliedConfigurationRevision),
    sql`${schema.workers.doctorObservedAt} > now() - interval '60 seconds'`,
  )).orderBy(asc(schema.workers.createdAt)).prepare("default_pools_workers"),
  findPool: db.select({ id: schema.runnerPools.id, driver: schema.runnerPools.driver, platform: schema.runnerPools.platform, imageDigest: schema.runnerPools.imageDigest }).from(schema.runnerPools).where(and(
    isNull(schema.runnerPools.organizationId),
    or(eq(schema.runnerPools.name, sql.placeholder("name")), eq(schema.runnerPools.triggerLabel, sql.placeholder("label"))),
  )).limit(1).prepare("default_pools_find"),
  findAlternate: db.select({ id: schema.runnerPools.id, driver: schema.runnerPools.driver, imageDigest: schema.runnerPools.imageDigest }).from(schema.runnerPools).where(and(isNull(schema.runnerPools.organizationId), eq(schema.runnerPools.name, sql.placeholder("name")))).limit(1).prepare("default_pools_find_alternate"),
  relabelArm64: db.update(schema.runnerPools).set({ triggerLabel: sql`${sql.placeholder("label")}`, labels: sql`${sql.placeholder("labels")}::jsonb` }).where(and(eq(schema.runnerPools.id, sql.placeholder("id")), eq(schema.runnerPools.triggerLabel, "mars-linux-arm64"))).prepare("default_pools_relabel_arm64"),
  updateResources: db.update(schema.runnerPools).set({ resources: sql`${sql.placeholder("resources")}::jsonb`, enabled: sql`${sql.placeholder("enabled")}` }).where(eq(schema.runnerPools.id, sql.placeholder("id"))).prepare("default_pools_update"),
  insert: db.insert(schema.runnerPools).values({
    organizationId: null, workerId: null,
    name: sql.placeholder("name"), platform: sql.placeholder("platform"), driver: sql.placeholder("driver"),
    imageDigest: sql.placeholder("imageDigest"), resources: sql.placeholder("resources"), labels: sql.placeholder("labels"),
    triggerLabel: sql.placeholder("label"), enabled: sql.placeholder("enabled"),
  }).prepare("default_pools_insert"),
}));

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

export async function ensureDefaultPools(db: DatabaseClient, images: PoolDefaults): Promise<void> {
  const prepared = queries(db);
  const workers = await prepared.workers.execute();
  const configuredWorkers = workers
    .map((worker) => ({ worker, limits: (typeof worker.limits === "string" ? JSON.parse(worker.limits) : worker.limits) as WorkerLimits, doctor: storedWorkerDoctor(worker.doctor), desired: typeof worker.desiredConfiguration === "string" ? JSON.parse(worker.desiredConfiguration) : worker.desiredConfiguration }))
    .filter(({ worker, limits, doctor, desired }) => worker.limits && Array.isArray(doctor.capabilities) && desired && typeof desired.selectedDriver === "string");
  let primaryArm64Driver: string | undefined;
  const guestPlatforms: GuestPlatform[] = ["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"];
  for (const platform of guestPlatforms) {
    let choices = configuredWorkers.flatMap(({ worker, limits, doctor, desired }) => {
      const driver = String(desired.selectedDriver);
      return guestPlatformsForWorker(worker).includes(platform) && Array.isArray(doctor.capabilities)
        && doctor.capabilities.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).driver === driver && (item as Record<string, unknown>).guestPlatform === platform && (item as Record<string, unknown>).ready === true)
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
    const resources = poolResourcesForWorkers(choices.map(({ limits }) => limits))
      ?? { vcpu: 4, memoryBytes: 6 * GIB, storageBytes: 30 * GIB, concurrency: 1 };
    const label = platform === "linux-x64" ? `mars-ubuntu-${images.ubuntuVersion ?? "24"}` : platform === "linux-arm64" ? "mars-ubuntu-arm64" : `mars-${platform}`;
    const labels = platform === "linux-arm64" ? [label, "ubuntu"] : [label];
    const name = `default-${platform}`;
    const enabled = choices.length > 0;
    const [existing] = await prepared.findPool.execute({ name, label });
    if (platform === "linux-arm64") primaryArm64Driver = String(existing?.driver ?? driver);
    if (existing) {
      const retained = configuredWorkers.filter(({ worker, doctor, desired }) => desired.selectedDriver === existing.driver && guestPlatformsForWorker(worker).includes(existing.platform as GuestPlatform) && workerPoolEvidence(doctor, String(existing.driver), String(existing.platform)).ready);
      const retainedResources = poolResourcesForWorkers(retained.map(({ limits }) => limits)) ?? resources;
      if (platform === "linux-arm64" && existing.platform === "linux-arm64") {
        await prepared.relabelArm64.execute({ label, labels: JSON.stringify(labels), id: existing.id });
      }
      await prepared.updateResources.execute({ resources: JSON.stringify(retainedResources), enabled: retained.length > 0, id: existing.id });
    } else {
      await prepared.insert.execute({ name, platform, driver, imageDigest: imageDigest ?? "", resources, labels, label, enabled });
    }
  }
  // Tart VMs and Docker containers share the Ubuntu route, but need separate
  // driver pools. Keep the original pool and its active leases intact.
  const alternateDriver = primaryArm64Driver === "tart-vm" ? "linux-docker-container" : "tart-vm";
  const alternateName = `default-linux-arm64-${alternateDriver === "tart-vm" ? "tart" : "container"}`;
  const alternates = configuredWorkers.filter(({ worker, doctor, desired }) =>
    desired.selectedDriver === alternateDriver && guestPlatformsForWorker(worker).includes("linux-arm64") &&
    (doctor.capabilities as Record<string, unknown>[]).some(capability =>
      capability.driver === alternateDriver && capability.guestPlatform === "linux-arm64" && capability.ready === true));
  const [alternate] = await prepared.findAlternate.execute({ name: alternateName });
  if (!alternates.length && !alternate) return;
  const digest = (alternates[0]?.doctor.capabilities as Record<string, unknown>[] | undefined)
    ?.find(capability => capability.driver === alternateDriver && capability.guestPlatform === "linux-arm64")?.imageDigest;
  const imageDigest = String(alternate?.imageDigest ?? digest ?? "");
  const ready = alternates.filter(({ doctor }) => workerPoolEvidence(doctor, alternateDriver, "linux-arm64").ready);
  const resources = poolResourcesForWorkers(ready.map(({ limits }) => limits))
    ?? { vcpu: 4, memoryBytes: 6 * GIB, storageBytes: 30 * GIB, concurrency: 1 };
  if (alternate) {
    await prepared.updateResources.execute({ resources: JSON.stringify(resources), enabled: ready.length > 0, id: alternate.id });
  } else {
    const trigger = `mars-ubuntu-arm64-${alternateDriver === "tart-vm" ? "tart" : "container"}`;
    await prepared.insert.execute({ name: alternateName, platform: "linux-arm64", driver: alternateDriver, imageDigest, resources, labels: ["mars-ubuntu-arm64", trigger, "ubuntu"], label: trigger, enabled: ready.length > 0 });
  }
}

