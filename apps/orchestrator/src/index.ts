import { LinuxContainerDriver } from "./linux-container.ts";
import { runLinuxWorker } from "./linux-agent.ts";
import { runMacWorker } from "./mac-agent.ts";
import { runWindowsWorker } from "./windows-agent.ts";

const limits = { maxVcpuPerPod: Number(Bun.env.MAX_VCPU_PER_POD ?? 4), maxMemoryBytesPerPod: Number(Bun.env.MAX_MEMORY_BYTES_PER_POD ?? 6 * 1024 ** 3), maxStorageBytesPerPod: Number(Bun.env.MAX_STORAGE_BYTES_PER_POD ?? 30 * 1024 ** 3), maxConcurrentPods: Number(Bun.env.MAX_CONCURRENT_PODS ?? 3) };
const baseUrl = Bun.env.MARS_CONTROL_PLANE_URL;

if (import.meta.main && Bun.argv[2] === "mac-worker") {
  if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required");
  await runMacWorker(baseUrl, limits);
} else if (import.meta.main && Bun.argv[2] === "windows-worker") {
  if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required");
  await runWindowsWorker(baseUrl, limits);
} else if (import.meta.main && Bun.argv[2] === "linux-worker") {
  if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required");
  const driver = new LinuxContainerDriver({
    image: Bun.env.MARS_LINUX_JOB_IMAGE,
    prefix: "mars",
    bootstrapRoot: Bun.env.MARS_BROKER_CONFIG ?? "/var/lib/mars/config",
    limits,
    readyTimeoutMs: Number(Bun.env.GUEST_READY_TIMEOUT_MS ?? 120_000),
    jobTimeoutMs: Number(Bun.env.JOB_TIMEOUT_MS ?? 900_000),
  });
  await runLinuxWorker(baseUrl, driver, limits);
} else if (import.meta.main) {
  console.error("usage: mars-orchestrator <linux-worker|mac-worker|windows-worker>");
  process.exitCode = 2;
}
