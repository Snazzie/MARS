import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_WORKER_CONTRACT_VERSION } from "../packages/contracts/src/index.ts";
import { deriveDevWorkerCode } from "./dev-worker-join.ts";

async function main(): Promise<void> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("dev:worker requires Linux x64 or ARM64 for this launcher");
  const token = Bun.env.MARS_DEV_TOKEN?.trim();
  if (!token) throw new Error("MARS_DEV_TOKEN is required");
  const root = join(homedir(), ".local", "share", "Mars", "dev-worker");
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
  const temp = enrolled ? null : await mkdtemp(join(tmpdir(), "mars-dev-linux-credential-"));
  let child: Bun.Subprocess | null = null;
  let stopping = false;
  const stop = () => { stopping = true; child?.kill(); };
  try {
    const credentialPath = temp ? join(temp, "join-code") : undefined;
    if (credentialPath) await writeFile(credentialPath, `${deriveDevWorkerCode(token)}\n`, { flag: "wx", mode: 0o600 });
    const env = {
      ...process.env,
      MARS_CONTROL_PLANE_URL: Bun.env.MARS_DEV_CONTROL_PLANE_URL?.trim() || "https://mars.snazzie.space",
      MARS_WORKER_VERSION: "0.0.0",
      MARS_WORKER_CONTRACT_VERSION: CURRENT_WORKER_CONTRACT_VERSION,
      MARS_WORKER_IDENTITY_FILE: identityPath,
      MARS_MACHINE_UUID: machineUuid,
      MARS_JOIN_CODE_FILE: credentialPath ?? "",
      MARS_ACTION_CACHE_ROOT: join(root, "action-cache"),
      MARS_LINUX_VM_PREFIX: "mars-dev",
      MARS_LINUX_CONTAINER_PREFIX: "mars-dev-linux-arm64",
    };
    child = Bun.spawn(["bun", "run", "apps/orchestrator/src/index.ts", process.arch === "arm64" ? "linux-container-worker" : "linux-worker"], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const exit = await child.exited;
    if (exit !== 0 && !stopping) throw new Error(`Development Linux worker exited ${exit}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
