import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist", "linux-arm64");
const workerVersion = Bun.env.WORKER_VERSION;
const brokerImage = Bun.env.BROKER_IMAGE ?? "ghcr.io/snazzie/mars/linux-broker";
if (!workerVersion) throw new Error("WORKER_VERSION is required");
const jobImage = `${brokerImage}-job`;

async function run(command: string[], cwd = root): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}): ${(stderr || stdout).trim().slice(0, 2_000)}`);
  return stdout.trim();
}
async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}
async function digest(reference: string, label: string): Promise<string> {
  const value = await run(["docker", "buildx", "imagetools", "inspect", reference, "--format", "{{.Manifest.Digest}}"]);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} has no immutable digest`);
  return value;
}
function asset(path: string, name: string) {
  return { url: `https://github.com/Snazzie/MARS/releases/download/worker-v${workerVersion}/${name}`, sha256: "" };
}

await mkdir(dist, { recursive: true });
await run(["bun", "build", "apps/orchestrator/src/index.ts", "--compile", "--target=bun-linux-arm64", "--outfile=dist/linux-arm64/mars-orchestrator"]);
await run(["bun", "build", "apps/job-agent/src/index.ts", "--compile", "--target=bun-linux-arm64", "--outfile=dist/linux-arm64/mars-job-agent"]);
await run(["bun", "run", "scripts/build-linux-arm64-runner.ts", "dist/linux-arm64/runner.tar.gz"]);
await copyFile(join(root, "deploy", "workers", "install-worker-linux-arm64.ps1"), join(dist, "install-worker-linux-arm64.ps1"));
await copyFile(join(root, "images", "jobs", "linux-arm64", "entrypoint.sh"), join(dist, "entrypoint.sh"));
await copyFile(join(root, "deploy", "workers", "linux-arm64-broker-compose.yaml"), join(dist, "linux-arm64-broker-compose.yaml"));
const baseDigest = await digest("ubuntu:24.04", "Ubuntu ARM64 base image");
await run(["docker", "buildx", "build", "--platform", "linux/arm64", "--build-arg", `BASE_IMAGE=ubuntu:24.04@${baseDigest}`, "--push", "-f", "deploy/workers/linux-arm64-broker.Dockerfile", "-t", `${brokerImage}:arm64-worker-v${workerVersion}`, "-t", `${brokerImage}:arm64-candidate`, "."]);
const brokerDigest = await digest(`${brokerImage}:arm64-worker-v${workerVersion}`, "ARM64 broker image");
await run(["docker", "buildx", "build", "--platform", "linux/arm64", "--build-arg", `BASE_IMAGE=ubuntu:24.04@${baseDigest}`, "-f", "images/jobs/linux-arm64/Containerfile", "--push", "-t", `${jobImage}:arm64-worker-v${workerVersion}`, "-t", `${jobImage}:arm64-candidate`, "dist/linux-arm64"]);
const jobDigest = await digest(`${jobImage}:arm64-worker-v${workerVersion}`, "ARM64 job image");
const metadata = {
  installer: asset("install-worker-linux-arm64.ps1", "install-worker-linux-arm64.ps1"),
  compose: asset("linux-arm64-broker-compose.yaml", "linux-arm64-broker-compose.yaml"),
  brokerImage: `${brokerImage}@${brokerDigest}`,
  jobImage: `${jobImage}@${jobDigest}`,
};
metadata.installer.sha256 = await sha256(join(dist, "install-worker-linux-arm64.ps1"));
metadata.compose.sha256 = await sha256(join(dist, "linux-arm64-broker-compose.yaml"));
await writeFile(join(dist, "metadata.json"), `${JSON.stringify(metadata)}\n`);
if (Bun.env.GITHUB_OUTPUT) await writeFile(Bun.env.GITHUB_OUTPUT, `json=${JSON.stringify(metadata)}\n`, { flag: "a" });
console.log(JSON.stringify(metadata));
