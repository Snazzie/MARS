import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerBuildImagePayload, workerBuildImageContentDescriptor, CURRENT_WORKER_CONTRACT_VERSION } from "../packages/contracts/src/index.ts";
import { prepareWindowsContainerImage } from "../apps/orchestrator/src/windows-image-build.ts";
import { deriveDevWorkerCode } from "./dev-worker-join.ts";

const image = "mars/windows-job:local";

async function command(args: string[], env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error((stderr || stdout).trim() || `${args[0]} exited ${exit}`);
  return stdout.trim();
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("dev:windows-worker requires Windows");
  const token = Bun.env.MARS_DEV_TOKEN?.trim();
  if (!token) throw new Error("MARS_DEV_TOKEN is required");
  const server = new URL(Bun.env.MARS_DEV_CONTROL_PLANE_URL?.trim() || "https://mars.snazzie.space");
  if (server.username || server.password || (server.protocol !== "https:" && !(server.protocol === "http:" && ["127.0.0.1", "localhost"].includes(server.hostname)))) throw new Error("MARS_DEV_CONTROL_PLANE_URL requires HTTPS or loopback HTTP");
  const controlPlane = server.origin;
  const service = await command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$s=Get-Service -Name MarsWorker -ErrorAction SilentlyContinue; if ($s -and $s.Status -eq 'Running') { 'running' } else { 'stopped' }"]);
  if (service !== "stopped") throw new Error("MarsWorker service is running; stop it manually before starting a separate development worker");

  const root = join(Bun.env.LOCALAPPDATA ?? join(Bun.env.USERPROFILE ?? "", "AppData", "Local"), "Mars", "dev-worker");
  await mkdir(root, { recursive: true });
  const identityPath = join(root, "worker-identity.json");
  const manifestPath = join(root, "windows-job-image.json");
  const machinePath = join(root, "machine-uuid");
  let machineUuid = await readFile(machinePath, "utf8").then(value => value.trim()).catch(() => "");
  if (!machineUuid) {
    machineUuid = randomUUID();
    await writeFile(machinePath, `${machineUuid}\n`, { flag: "wx", mode: 0o600 });
  }
  let enrolled = false;
  try {
    const identity: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!identity || typeof identity !== "object" || ("workerId" in identity && typeof identity.workerId !== "string")) throw new Error("invalid worker identity");
    enrolled = "workerId" in identity && Boolean(identity.workerId);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error("Development worker identity is unreadable; refusing to replace it", { cause: error });
  }

  if (Bun.env.MARS_DEV_BUILD_WINDOWS_IMAGE === "true") {
    const dockerMode = await command(["docker.exe", "info", "--format", "{{.OSType}}"]).catch(() => "");
    if (dockerMode.toLowerCase() !== "windows") throw new Error("Windows image preparation requires an active Windows Docker engine; omit MARS_DEV_BUILD_WINDOWS_IMAGE to discover the current host capabilities");
    const response = await fetch(`${controlPlane}/api/workers/dev-windows-image-build`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(response.status === 503
      ? "Development image payload unavailable (HTTP 503): control plane is missing Windows container build inputs"
      : `Development image payload unavailable (HTTP ${response.status}); verify the dev control-plane adapter and matching MARS_DEV_TOKEN`);
    const payload = WorkerBuildImagePayload.parse(await response.json());
    if (payload.image !== image || createHash("sha256").update(workerBuildImageContentDescriptor(payload)).digest("hex") !== payload.contentSha256) throw new Error("Development image payload identity or content digest mismatch");
    for (const artifact of [...Object.values(payload.artifacts), payload.runner, payload.git, payload.vcRuntime]) {
      const url = new URL(artifact.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Development image artifacts require credential-free HTTPS URLs");
    }
    const { imageId } = await prepareWindowsContainerImage(payload, manifestPath);
    console.log(`Verified development Windows image ${imageId}`);
  }

  const temp = enrolled ? null : await mkdtemp(join(root, "credential-"));
  let child: Bun.Subprocess | null = null;
  const stop = () => { child?.kill(); };
  try {
    let credentialPath: string | undefined;
    if (temp) {
      credentialPath = join(temp, "join-code");
      await writeFile(credentialPath, `${deriveDevWorkerCode(token)}\n`, { flag: "wx", mode: 0o600 });
      await command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$p=$env:MARS_DEV_CREDENTIAL_PATH; $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl"], { MARS_DEV_CREDENTIAL_PATH: credentialPath });
    }
    const env = {
      ...process.env,
      MARS_CONTROL_PLANE_URL: controlPlane,
      MARS_WINDOWS_RUNTIME: "",
      MARS_WINDOWS_CONTAINER_IMAGE: image,
      MARS_WINDOWS_CONTAINER_PREFIX: "mars-dev",
      MARS_ALLOW_LOCAL_CONTAINER_IMAGE: "true",
      MARS_WORKER_VERSION: "0.0.0",
      MARS_DEV_WORKER_CONSOLE_LOGS: "true",
      MARS_WORKER_CONTRACT_VERSION: CURRENT_WORKER_CONTRACT_VERSION,
      MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST: manifestPath,
      MARS_ACTION_CACHE_ROOT: join(root, "action-cache"),
      MARS_LEASE_PICKUP_STATE_FILE: join(root, "lease-pickup.json"),
      MARS_WORKER_IDENTITY_FILE: identityPath,
      MARS_MACHINE_UUID: machineUuid,
      ...(credentialPath ? { MARS_JOIN_CODE_FILE: credentialPath } : { MARS_JOIN_CODE_FILE: "" }),
    };
    child = Bun.spawn(["bun", "run", "apps/orchestrator/src/index.ts", "windows-worker"], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const exit = await child.exited;
    if (exit !== 0) throw new Error(`Development Windows worker exited ${exit}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
