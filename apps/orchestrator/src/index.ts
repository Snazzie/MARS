import { KataK3sDriver } from "./kata-k3s.ts";
import { runWorkerJoin } from "./mac-agent.ts";

if (import.meta.main && Bun.argv[2] === "join") {
  const platform = Bun.argv[3];
  if (platform !== "macos-arm64" && platform !== "windows-x64") throw new Error("unsupported join platform");
  const baseUrl = Bun.env.WHITESMITH_CONTROL_PLANE_URL;
  if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required");
  await runWorkerJoin(platform, baseUrl);
} else {
  const limits={maxVcpuPerPod:Number(Bun.env.MAX_VCPU_PER_POD??4),maxMemoryBytesPerPod:Number(Bun.env.MAX_MEMORY_BYTES_PER_POD??4*1024**3),maxStorageBytesPerPod:Number(Bun.env.MAX_STORAGE_BYTES_PER_POD??20*1024**3),maxConcurrentPods:Number(Bun.env.MAX_CONCURRENT_PODS??2)};
  const driver=new KataK3sDriver(limits);
  if(Bun.env.WHITESMITH_RUNTIME !== "kata-k3s") throw new Error("Linux orchestrator requires kata-k3s; no default runtime fallback");
  console.log(JSON.stringify({service:"orchestrator",driver:driver.name,limits}));
}
