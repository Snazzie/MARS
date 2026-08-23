import { mkdtemp, unlink, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerJitConfig, WorkerCacheProxy } from "@whitesmith/contracts";

type GuestBootstrap = { version: 1; leaseId: string; nonce: string; encodedJitConfig: string; callbackUrl?: string; callbackToken?: string; workerCache?: WorkerCacheProxy };
export function cliArgument(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
export async function runRunnerWithWorkerCache(encodedJitConfig: string, runnerRoot: string, platform: "windows-x64" | "linux-x64", workerCache?: WorkerCacheProxy, onOutput?: (stream: "stdout" | "stderr", content: string) => void): Promise<number> {
  RunnerJitConfig.shape.encodedJitConfig.parse(encodedJitConfig);
  let caDirectory: string | undefined;
  try {
    const env: Record<string, string> = { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: encodedJitConfig };
    if (workerCache) {
      const proxy = WorkerCacheProxy.parse(workerCache);
      caDirectory = await mkdtemp(join(tmpdir(), "whitesmith-worker-cache-"));
      const caPath = join(caDirectory, "worker-ca.pem");
      await writeFile(caPath, proxy.caCertificatePem, { mode: 0o600, flag: "wx" });
      env.HTTP_PROXY = proxy.proxyUrl;
      env.http_proxy = proxy.proxyUrl;
      env.HTTPS_PROXY = proxy.proxyUrl;
      env.https_proxy = proxy.proxyUrl;
      env.NO_PROXY = "";
      env.no_proxy = "";
      env.NODE_EXTRA_CA_CERTS = caPath;
      env.node_extra_ca_certs = caPath;
    }
    const runnerCommand = Bun.env.WHITESMITH_RUNNER_COMMAND ?? (platform === "windows-x64" ? "run.cmd" : "./run.sh");
    const command = platform === "windows-x64" ? (runnerCommand.endsWith(".sh") ? ["bash", runnerCommand] : ["cmd.exe", "/c", runnerCommand]) : [runnerCommand];
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
    if (caDirectory) await rm(caDirectory, { recursive: true, force: true });
  }
}
export async function consumeGuestJitConfig(encoded: string, runnerRoot: string, platform: "windows-x64" | "linux-x64" = process.platform === "win32" ? "windows-x64" : "linux-x64"): Promise<number> {
  return runRunnerWithWorkerCache(encoded, runnerRoot, platform);
}
async function consumeJitConfigFile(configPath: string, runnerRoot: string): Promise<number> {
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
    return await runRunnerWithWorkerCache(encoded, runnerRoot, process.platform === "win32" ? "windows-x64" : "linux-x64", workerCache);
  } finally {
    bytes.fill(0);
  }
}
export async function consumeGuestJitConfigWithWorkerCache(encoded: string, runnerRoot: string, platform: "windows-x64" | "linux-x64", workerCache: WorkerCacheProxy): Promise<number> {
  return runRunnerWithWorkerCache(encoded, runnerRoot, platform, workerCache);
}
export async function runOneTimeJitBootstrap(configPath: string, runnerRoot: string): Promise<void> { try { if (await consumeJitConfigFile(configPath, runnerRoot) !== 0) throw new Error("runner exited unsuccessfully"); } finally { await unlink(configPath).catch(() => undefined); } }
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

export async function runGuestService(
  platform: "windows-x64" | "linux-x64",
  bootstrapPath: string,
  runnerRoot: string,
  completionMode: "shutdown" | "exit" = "shutdown",
  shutdown: (platform: "windows-x64" | "linux-x64") => Promise<void> | void = defaultGuestShutdown,
): Promise<void> {
  const raw = await waitForGuestBootstrap(bootstrapPath, Number.POSITIVE_INFINITY);
  await unlink(bootstrapPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EPERM" && error.code !== "EROFS" && error.code !== "EACCES") throw error;
  });
  const bootstrap = JSON.parse(raw) as GuestBootstrap;
  const exitCode = await runRunnerWithWorkerCache(bootstrap.encodedJitConfig, runnerRoot, platform, bootstrap.workerCache);
  if (bootstrap.callbackUrl || bootstrap.callbackToken) {
    if (!bootstrap.callbackUrl || !bootstrap.callbackToken) throw new Error("guest bootstrap callback invalid");
    const response = await fetch(bootstrap.callbackUrl, { method: "POST", headers: { authorization: `Bearer ${bootstrap.callbackToken}`, "content-type": "application/json" }, body: JSON.stringify({ leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, exitCode }) });
    if (!response.ok) throw new Error(`lease callback failed: ${response.status}`);
  }
  if (completionMode === "exit") return;
  await shutdown(platform);
}

async function defaultGuestShutdown(platform: "windows-x64" | "linux-x64"): Promise<void> {
  const command = platform === "windows-x64" ? ["shutdown.exe", "/s", "/t", "0"] : ["systemctl", "poweroff"];
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
}
export function runnerCommandForPlatform(platform: "windows-x64" | "linux-x64"): string[] {
  return platform === "windows-x64" ? ["cmd.exe", "/c", "run.cmd"] : ["./run.sh"];
}
