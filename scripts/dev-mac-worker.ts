import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_WORKER_CONTRACT_VERSION } from "../packages/contracts/src/index.ts";
import { deriveDevWorkerCode } from "./dev-worker-join.ts";

const controlPlane = "https://mars.snazzie.space";

type ImageManifest = { localTarget: string; preparedDigest: string };

async function preparedImage(platform: "macos" | "linux-arm64"): Promise<ImageManifest> {
  const path = join(homedir(), "Library", "Application Support", "Mars", "dev-worker", `${platform}-tart-image-manifest.json`);
  let manifest: ImageManifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8")) as ImageManifest;
  } catch (error) {
    throw new Error(`Prepared ${platform} Tart image manifest unavailable at ${path}; prepare the worker images with the macOS installer`, { cause: error });
  }
  if (!manifest || typeof manifest.localTarget !== "string" || !manifest.localTarget ||
      typeof manifest.preparedDigest !== "string" || !new RegExp(`^mars-${platform === "macos" ? "macos" : "linux"}-arm64-job@sha256:[0-9a-f]{64}$`).test(manifest.preparedDigest)) {
    throw new Error(`Prepared ${platform} Tart image manifest is invalid: ${path}`);
  }
  return manifest;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("dev:mac-worker requires Apple Silicon macOS");
  const token = Bun.env.MARS_DEV_TOKEN?.trim();
  if (!token) throw new Error("MARS_DEV_TOKEN is required");
  const service = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid!()}/com.mars.worker`]);
  if (service.exitCode === 0) throw new Error("com.mars.worker LaunchAgent is loaded; stop it manually before starting a separate development worker");
  if (!new TextDecoder().decode(service.stderr).includes('Could not find service "com.mars.worker"')) {
    throw new Error("Could not determine com.mars.worker LaunchAgent state; refusing to start");
  }
  const tart = Bun.spawnSync(["tart", "--version"]);
  if (tart.exitCode !== 0) throw new Error("Tart must be installed and available on PATH");
  const root = join(homedir(), "Library", "Application Support", "Mars", "dev-worker");
  const [macos, linux] = await Promise.all([preparedImage("macos"), preparedImage("linux-arm64")]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const identityPath = join(root, "worker-identity.json");
  let enrolled = false;
  try {
    const identity: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!identity || typeof identity !== "object" || !("workerId" in identity) || typeof identity.workerId !== "string") throw new Error("invalid worker identity");
    enrolled = Boolean(identity.workerId);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error("Development worker identity is unreadable; refusing to replace it", { cause: error });
  }
  const machinePath = join(root, "machine-uuid");
  let machineUuid = await readFile(machinePath, "utf8").then(value => value.trim()).catch(error => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (!machineUuid) {
    machineUuid = randomUUID();
    await writeFile(machinePath, `${machineUuid}\n`, { flag: "wx", mode: 0o600 });
  }
  const temp = enrolled ? null : await mkdtemp(join(tmpdir(), "mars-dev-mac-credential-"));
  let child: Bun.Subprocess | null = null;
  let stopping = false;
  const stop = () => { stopping = true; child?.kill(); };
  try {
    const credentialPath = temp ? join(temp, "join-code") : undefined;
    if (credentialPath) await writeFile(credentialPath, `${deriveDevWorkerCode(token)}\n`, { flag: "wx", mode: 0o600 });
    const statusItem = join(root, "mars-status-item");
    const build = Bun.spawn(["swiftc", "-parse-as-library", "apps/macos-status-item/main.swift", "-o", statusItem], { stdout: "inherit", stderr: "inherit" });
    if (await build.exited !== 0) throw new Error("Could not build macOS status item; install Xcode Command Line Tools");
    const env = {
      ...process.env,
      MARS_CONTROL_PLANE_URL: controlPlane,
      MARS_WORKER_VERSION: "0.0.0",
      MARS_DEV_WORKER_CONSOLE_LOGS: "true",
      MARS_WORKER_CONTRACT_VERSION: CURRENT_WORKER_CONTRACT_VERSION,
      MARS_WORKER_IDENTITY_FILE: identityPath,
      MARS_MACHINE_UUID: machineUuid,
      MARS_JOIN_CODE_FILE: credentialPath ?? "",
      MARS_TART_MACOS_BASE_IMAGE: macos.localTarget,
      MARS_TART_MACOS_IMAGE_DIGEST: macos.preparedDigest,
      MARS_TART_LINUX_ARM64_BASE_IMAGE: linux.localTarget,
      MARS_TART_LINUX_ARM64_IMAGE_DIGEST: linux.preparedDigest,
      MARS_MACOS_STATUS_ITEM_EXECUTABLE: statusItem,
      MARS_MACOS_STATUS_ITEM_ICON: join(root, "mars-icon.png"),
      MARS_LEASE_PICKUP_STATE_FILE: join(root, "lease-pickup.json"),
      MARS_ACTION_CACHE_ROOT: join(root, "action-cache"),
    };
    child = Bun.spawn(["bun", "run", "apps/orchestrator/src/index.ts", "mac-worker"], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const exit = await child.exited;
    if (exit !== 0 && !stopping) throw new Error(`Development macOS worker exited ${exit}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
