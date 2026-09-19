import { access, mkdtemp, unlink, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RunnerJitConfig, WorkerCacheProxy } from "@mars/contracts";

const guestJobBootstrap = z.object({
  version: z.literal(1),
  leaseId: z.string().min(1),
  nonce: z.string().min(1),
  encodedJitConfig: z.string().min(1),
  callbackUrl: z.string().url().optional(),
  callbackToken: z.string().min(1).optional(),
  workerCache: WorkerCacheProxy.optional(),
}).strict().refine(value => Boolean(value.callbackUrl) === Boolean(value.callbackToken), "guest bootstrap callback invalid");
const guestProbeBootstrap = z.object({ version: z.literal(1), mode: z.literal("probe"), nonce: z.string().min(32) }).strict();
export const GuestBootstrap = z.union([guestProbeBootstrap, guestJobBootstrap]);
export type GuestBootstrap = z.infer<typeof GuestBootstrap>;

export function parseGuestBootstrap(raw: string): GuestBootstrap {
  return GuestBootstrap.parse(JSON.parse(raw));
}
export function cliArgument(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
async function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Windows trust operation failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return stdout.trim();
}
export interface WindowsTrustAdapter {
  addRoot(certificatePath: string): Promise<{ thumbprint: string; added: boolean }>;
  removeRoot(thumbprint: string): Promise<void>;
}

const powerShellWindowsTrust: WindowsTrustAdapter = {
  async addRoot(certificatePath) {
    const result = await runPowerShell(`$ErrorActionPreference='Stop';$cert=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new('${certificatePath.replace(/'/g, "''")}');$store=[System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine');try{$store.Open('ReadWrite');$existing=$store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false).Count -gt 0;if(-not $existing){$store.Add($cert);$added='1'}else{$added='0'}}finally{$store.Close()};Write-Output ($cert.Thumbprint+'|'+$added)`);
    const [thumbprint, added] = result.split("|");
    if (!thumbprint) throw new Error("Windows trust operation returned no certificate thumbprint");
    return { thumbprint, added: added === "1" };
  },
  async removeRoot(thumbprint) {
    await runPowerShell(`$ErrorActionPreference='Stop';$store=[System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine');try{$store.Open('ReadWrite');$found=$store.Certificates.Find('FindByThumbprint','${thumbprint.replace(/'/g, "''")}',$false);if($found.Count -gt 0){$store.Remove($found[0])}}finally{$store.Close()}`);
  },
};
const WORKER_CACHE_CAPABILITY = "mars-worker-cache-registration-v1";

async function assertWorkerCacheRunnerCapability(runnerRoot: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(runnerRoot, ".mars-capabilities.json"), "utf8"));
  } catch {
    throw new Error(`Actions Runner is missing required capability ${WORKER_CACHE_CAPABILITY}`);
  }
  if (!value || typeof value !== "object" || !("capabilities" in value) || !Array.isArray(value.capabilities) || !value.capabilities.includes(WORKER_CACHE_CAPABILITY)) {
    throw new Error(`Actions Runner is missing required capability ${WORKER_CACHE_CAPABILITY}`);
  }
}

export function mergeBunInstallCa(source: string, caPath: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const installStart = lines.findIndex((line) => /^\s*\[install\]\s*(?:#.*)?$/.test(line));
  const setting = `cafile = ${JSON.stringify(caPath.replaceAll("\\", "/"))}`;
  if (installStart < 0) {
    const prefix = source.length > 0 && !source.endsWith("\n") ? "\n" : "";
    return `${source}${prefix}[install]\n${setting}\n`;
  }
  const nextSection = lines.findIndex((line, index) => index > installStart && /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  const installEnd = nextSection < 0 ? lines.length : nextSection;
  const merged = lines.filter((line, index) => index <= installStart || index >= installEnd || !/^\s*(?:ca|cafile)\s*=/.test(line));
  merged.splice(installStart + 1, 0, setting);
  return merged.join("\n");
}


export async function runRunnerWithWorkerCache(encodedJitConfig: string, runnerRoot: string, platform: "windows-x64" | "linux-x64" | "linux-arm64", workerCache?: WorkerCacheProxy, onOutput?: (stream: "stdout" | "stderr", content: string) => void, windowsTrust: WindowsTrustAdapter = powerShellWindowsTrust): Promise<number> {
  RunnerJitConfig.shape.encodedJitConfig.parse(encodedJitConfig);
  let caDirectory: string | undefined;
  let addedRootThumbprint: string | undefined;
  try {
    const env: Record<string, string> = {
      ...Bun.env,
      ACTIONS_RUNNER_INPUT_JITCONFIG: encodedJitConfig,
      ACTIONS_RUNNER_INPUT_DISABLEUPDATE: "1",
      RUNNER_MANUALLY_TRAP_SIG: "1",
    };
    if (workerCache) {
      const proxy = WorkerCacheProxy.parse(workerCache);
      await assertWorkerCacheRunnerCapability(runnerRoot);
      caDirectory = await mkdtemp(join(tmpdir(), "mars-worker-cache-"));
      const workerCaPath = join(caDirectory, "worker-ca.pem");
      await writeFile(workerCaPath, proxy.caCertificatePem, { mode: 0o600, flag: "wx" });
      const caPath = join(caDirectory, "combined-ca.pem");
      let publicCa = "";
      if (platform === "windows-x64") {
        try {
          publicCa = await readFile("C:\\Git\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt", "utf8");
        } catch {
          publicCa = "";
        }
      }
      await writeFile(caPath, `${publicCa}${publicCa.endsWith("\n") || !publicCa ? "" : "\n"}${proxy.caCertificatePem}`, { mode: 0o600, flag: "wx" });
      const configuredBunRoot = Bun.env.XDG_CONFIG_HOME?.trim() || Bun.env.HOME?.trim() || Bun.env.USERPROFILE?.trim();
      const existingBunfigPath = configuredBunRoot ? join(configuredBunRoot, ".bunfig.toml") : undefined;
      const existingBunfig = existingBunfigPath ? await readFile(existingBunfigPath, "utf8").catch(() => "") : "";
      await writeFile(join(caDirectory, ".bunfig.toml"), mergeBunInstallCa(existingBunfig, caPath), { mode: 0o600, flag: "wx" });
      env.XDG_CONFIG_HOME = caDirectory;
      const gitConfigPath = join(caDirectory, "git-ca.config");
      await writeFile(gitConfigPath, `[http]
	sslBackend = openssl
	sslVerify = true
	sslCAInfo = ${caPath.replaceAll("\\", "/")}
`, { mode: 0o600, flag: "wx" });
      env.HTTP_PROXY = proxy.proxyUrl;
      env.http_proxy = proxy.proxyUrl;
      env.HTTPS_PROXY = proxy.proxyUrl;
      env.https_proxy = proxy.proxyUrl;
      env.NO_PROXY = "127.0.0.1,::1";
      env.no_proxy = "127.0.0.1,::1";
      env.NODE_EXTRA_CA_CERTS = caPath;
      env.node_extra_ca_certs = caPath;
      env.GIT_CONFIG_COUNT = "3";
      env.GIT_CONFIG_KEY_0 = "http.sslBackend";
      env.GIT_CONFIG_VALUE_0 = "openssl";
      env.GIT_CONFIG_KEY_1 = "http.sslVerify";
      env.GIT_CONFIG_VALUE_1 = "true";
      env.GIT_CONFIG_KEY_2 = "http.sslCAInfo";
      env.GIT_CONFIG_VALUE_2 = caPath;
      env.GIT_CONFIG_GLOBAL = gitConfigPath;
      env.GIT_SSL_BACKEND = "openssl";
      env.GIT_SSL_CAINFO = caPath;
      env.MARS_WORKER_CACHE_REGISTRATION_URL = proxy.registrationUrl;
      env.MARS_WORKER_CACHE_REGISTRATION_CHALLENGE = proxy.registrationChallenge;
      if (platform === "windows-x64") {
        const installed = await windowsTrust.addRoot(workerCaPath);
        if (installed.added) addedRootThumbprint = installed.thumbprint;
      }
    }
    const configuredRunnerCommand = Bun.env.MARS_RUNNER_COMMAND;
    const command = configuredRunnerCommand
      ? platform === "windows-x64" && !configuredRunnerCommand.endsWith(".sh")
        ? ["cmd.exe", "/c", configuredRunnerCommand]
        : [configuredRunnerCommand]
      : runnerCommandForPlatform(platform);
    const runner = Bun.spawn(command, { cwd: runnerRoot, env, stdout: onOutput ? "pipe" : "ignore", stderr: onOutput ? "pipe" : "ignore" });
    if (!onOutput) return await runner.exited;
    const stdout = runner.stdout;
    const stderr = runner.stderr;
    if (!stdout || !stderr) throw new Error("runner output streams unavailable");
    const output = async (stream: typeof stdout, name: "stdout" | "stderr") => {
      const reader = stream.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        onOutput(name, new TextDecoder().decode(item.value));
      }
    };
    await Promise.all([output(stdout, "stdout"), output(stderr, "stderr")]);
    return await runner.exited;
  } finally {
    let trustCleanupError: unknown;
    if (addedRootThumbprint && platform === "windows-x64") {
      try { await windowsTrust.removeRoot(addedRootThumbprint); } catch (error) { trustCleanupError = error; }
    }
    let caCleanupError: unknown;
    if (caDirectory) {
      try { await rm(caDirectory, { recursive: true, force: true }); } catch (error) { caCleanupError = error; }
    }
    if (trustCleanupError && caCleanupError) throw new AggregateError([trustCleanupError, caCleanupError], "Failed to remove worker cache trust");
    if (trustCleanupError) throw trustCleanupError;
    if (caCleanupError) throw caCleanupError;
  }
}
export async function consumeGuestJitConfig(encoded: string, runnerRoot: string, platform: "windows-x64" | "linux-x64" | "linux-arm64" = process.platform === "win32" ? "windows-x64" : "linux-x64"): Promise<number> {
  return runRunnerWithWorkerCache(encoded, runnerRoot, platform);
}
async function consumeJitConfigFile(configPath: string, runnerRoot: string, onOutput?: (stream: "stdout" | "stderr", content: string) => void): Promise<number> {
  const bytes = await readFile(configPath);
  try {
    const raw = bytes.toString("utf8").trim();
    if (!raw) throw new Error("jit config missing");
    let encoded = raw;
    let workerCache: WorkerCacheProxy | undefined;
    try {
      const parsed = JSON.parse(raw) as { encodedJitConfig?: unknown; workerCache?: unknown };
      if (typeof parsed.encodedJitConfig === "string") {
        encoded = parsed.encodedJitConfig;
        workerCache = parsed.workerCache as WorkerCacheProxy | undefined;
      }
    } catch {}
    return await runRunnerWithWorkerCache(encoded, runnerRoot, process.platform === "win32" ? "windows-x64" : "linux-x64", workerCache, onOutput);
  } finally {
    bytes.fill(0);
  }
}
export async function consumeGuestJitConfigWithWorkerCache(encoded: string, runnerRoot: string, platform: "windows-x64" | "linux-x64" | "linux-arm64", workerCache: WorkerCacheProxy, windowsTrust: WindowsTrustAdapter = powerShellWindowsTrust): Promise<number> {
  return runRunnerWithWorkerCache(encoded, runnerRoot, platform, workerCache, undefined, windowsTrust);
}
export async function runOneTimeJitBootstrap(configPath: string, runnerRoot: string): Promise<void> {
  try {
    const exitCode = await consumeJitConfigFile(configPath, runnerRoot, (stream, content) => {
      if (stream === "stdout") process.stdout.write(content);
      else process.stderr.write(content);
    });
    if (exitCode !== 0) throw new Error(`runner exited unsuccessfully: ${exitCode}`);
  } finally {
    await unlink(configPath).catch(() => undefined);
  }
}
export async function waitForGuestBootstrap(
  bootstrapPath: string,
  timeoutMs = 300_000,
  pollMs = 250,
  pause: (milliseconds: number) => Promise<void> = Bun.sleep,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      return await readFile(bootstrapPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await pause(pollMs);
  } while (Date.now() < deadline);
  throw new Error(`guest bootstrap was not copied within ${timeoutMs}ms`);
}

export interface WindowsProbeAdapter {
  isSystem(): Promise<boolean>;
  serviceTaskExecutable(): Promise<string>;
  exists(path: string): Promise<boolean>;
  writeResult(result: { version: 1; success: true; nonce: string } | { version: 1; success: false; nonce: string; error: string }): Promise<void>;
}

const windowsProbeAdapter: WindowsProbeAdapter = {
  async isSystem() {
    return (await runPowerShell("[Security.Principal.WindowsIdentity]::GetCurrent().IsSystem")).toLowerCase() === "true";
  },
  async serviceTaskExecutable() {
    return runPowerShell("(Get-ScheduledTask -TaskName 'MarsGuestService' -ErrorAction Stop).Actions.Execute");
  },
  async exists(path) {
    try { await access(path); return true; } catch { return false; }
  },
  async writeResult(result) {
    await writeFile("C:\\ProgramData\\Mars\\provisioning-probe.json", JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
  },
};

const probeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 512);
export async function runWindowsProvisioningProbe(nonce: string, runnerRoot: string, adapter: WindowsProbeAdapter = windowsProbeAdapter): Promise<void> {
  try {
    if (!await adapter.isSystem()) throw new Error("probe must run as SYSTEM");
    const executable = await adapter.serviceTaskExecutable();
    if (executable.toLowerCase() !== "c:\\program files\\mars\\mars-job-agent.exe") throw new Error("MarsGuestService executable is invalid");
    const required = [
      join(runnerRoot, "run.cmd"),
      join(runnerRoot, ".mars-capabilities.json"),
      "C:\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Mars\\mars-job-agent.exe",
    ];
    for (const path of required) if (!await adapter.exists(path)) throw new Error(`required probe path is missing: ${path}`);
    const capability = JSON.parse(await readFile(join(runnerRoot, ".mars-capabilities.json"), "utf8")) as { schemaVersion?: unknown; capabilities?: unknown };
    if (capability.schemaVersion !== 1 || !Array.isArray(capability.capabilities) || !capability.capabilities.includes(WORKER_CACHE_CAPABILITY)) throw new Error("runner capability manifest is invalid");
    await adapter.writeResult({ version: 1, success: true, nonce });
  } catch (error) {
    await adapter.writeResult({ version: 1, success: false, nonce, error: probeError(error) });
  }
}

export async function runGuestService(
  platform: "windows-x64" | "linux-x64" | "linux-arm64",
  bootstrapPath: string,
  runnerRoot: string,
  completionMode: "shutdown" | "exit" = "shutdown",
  shutdown: (platform: "windows-x64" | "linux-x64" | "linux-arm64") => Promise<void> | void = defaultGuestShutdown,
  probeAdapter: WindowsProbeAdapter = windowsProbeAdapter,
): Promise<void> {
  const raw = await waitForGuestBootstrap(bootstrapPath, Number.POSITIVE_INFINITY);
  await unlink(bootstrapPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EPERM" && error.code !== "EROFS" && error.code !== "EACCES") throw error;
  });
  const bootstrap = parseGuestBootstrap(raw);
  if ("mode" in bootstrap) {
    if (platform !== "windows-x64") throw new Error("provisioning probes require windows-x64");
    await runWindowsProvisioningProbe(bootstrap.nonce, runnerRoot, probeAdapter);
    await shutdown(platform);
    return;
  }
  const exitCode = await runRunnerWithWorkerCache(bootstrap.encodedJitConfig, runnerRoot, platform, bootstrap.workerCache);
  if (bootstrap.callbackUrl) {
    const response = await fetch(bootstrap.callbackUrl, { method: "POST", headers: { authorization: `Bearer ${bootstrap.callbackToken!}`, "content-type": "application/json" }, body: JSON.stringify({ leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, exitCode }) });
    if (!response.ok) throw new Error(`lease callback failed: ${response.status}`);
  }
  if (completionMode === "exit") return;
  await shutdown(platform);
}

async function defaultGuestShutdown(platform: "windows-x64" | "linux-x64" | "linux-arm64"): Promise<void> {
  if (platform === "linux-arm64") return;
  const command = platform === "windows-x64" ? ["shutdown.exe", "/s", "/t", "0"] : ["systemctl", "poweroff"];
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
}
export function runnerCommandForPlatform(platform: "windows-x64" | "linux-x64" | "linux-arm64"): string[] {
  return platform === "windows-x64" ? ["cmd.exe", "/c", "run.cmd"] : ["./bin/Runner.Listener", "run"];
}
