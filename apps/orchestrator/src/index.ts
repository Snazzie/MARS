import { LibvirtVmDriver } from "./libvirt-vm.ts";
import { runLinuxWorker, runDockerLinuxWorker } from "./linux-agent.ts";
import { LinuxContainerDriver } from "./linux-container.ts";
import { runWindowsWorker } from "./windows-agent.ts";
import { runMacWorker } from "./mac-agent.ts";

const limits = { maxVcpuPerPod: Number(Bun.env.MAX_VCPU_PER_POD ?? 4), maxMemoryBytesPerPod: Number(Bun.env.MAX_MEMORY_BYTES_PER_POD ?? 6 * 1024 ** 3), maxStorageBytesPerPod: Number(Bun.env.MAX_STORAGE_BYTES_PER_POD ?? 30 * 1024 ** 3), maxConcurrentPods: Number(Bun.env.MAX_CONCURRENT_PODS ?? 3) };
const baseUrl = Bun.env.MARS_CONTROL_PLANE_URL;

if (import.meta.main && Bun.argv[2] === "mac-worker") {
  if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required");
  await runMacWorker(baseUrl, limits);
} else if (import.meta.main && Bun.argv[2] === "windows-worker") {
  if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required");
  await runWindowsWorker(baseUrl, limits);
} else if (import.meta.main && Bun.argv[2] === "linux-worker") {
  const required = ["MARS_GOLDEN_DISK", "MARS_GOLDEN_DIGEST", "MARS_DOMAIN_TEMPLATE", "MARS_CLONE_ROOT", "MARS_CHANNEL_ROOT", "MARS_LIBVIRT_NETWORK"] as const;
  const missing = required.filter((name) => !Bun.env[name]);
  if (!baseUrl || missing.length) throw new Error(`Linux worker configuration missing: ${[...(baseUrl ? [] : ["MARS_CONTROL_PLANE_URL"]), ...missing].join(", ")}`);
  const driver = new LibvirtVmDriver({ goldenDisk: Bun.env.MARS_GOLDEN_DISK!, goldenDigest: Bun.env.MARS_GOLDEN_DIGEST! as `sha256:${string}`, domainTemplate: Bun.env.MARS_DOMAIN_TEMPLATE!, cloneRoot: Bun.env.MARS_CLONE_ROOT!, channelRoot: Bun.env.MARS_CHANNEL_ROOT!, network: Bun.env.MARS_LIBVIRT_NETWORK!, prefix: "mars", limits, guestReadyTimeoutMs: Number(Bun.env.GUEST_READY_TIMEOUT_MS ?? 120_000) });
  await runLinuxWorker(baseUrl, driver, limits);
} else if (import.meta.main && (Bun.argv[2] === "linux-container-worker" || Bun.argv[2] === "docker-linux-worker")) {
  const required = ["MARS_LINUX_ARM64_CONTAINER_IMAGE", "MARS_LINUX_CONTAINER_NETWORK"] as const;
  const missing = required.filter((name) => !Bun.env[name]);
  if (!baseUrl || missing.length || !/^.+@sha256:[0-9a-f]{64}$/.test(Bun.env.MARS_LINUX_ARM64_CONTAINER_IMAGE ?? "")) throw new Error(`Linux ARM container worker configuration missing or invalid: ${[...(baseUrl ? [] : ["MARS_CONTROL_PLANE_URL"]), ...missing, ...(/^.+@sha256:[0-9a-f]{64}$/.test(Bun.env.MARS_LINUX_ARM64_CONTAINER_IMAGE ?? "") ? [] : ["MARS_LINUX_ARM64_CONTAINER_IMAGE"])].join(", ")}`);
  const driver = new LinuxContainerDriver({ image: Bun.env.MARS_LINUX_ARM64_CONTAINER_IMAGE!, prefix: "mars-linux-arm64", network: Bun.env.MARS_LINUX_CONTAINER_NETWORK!, limits, hostPlacement: "linux-pin" });
  await runDockerLinuxWorker(baseUrl, driver, limits);
} else if (import.meta.main) {
  console.error("usage: mars-orchestrator <linux-worker|linux-container-worker|mac-worker|windows-worker>");
  process.exitCode = 2;
}
