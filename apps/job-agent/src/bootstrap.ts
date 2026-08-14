import { unlink, readFile } from "node:fs/promises";
import { RunnerJitConfig } from "@whitesmith/contracts";

type GuestBootstrap = { version: 1; leaseId: string; nonce: string; encodedJitConfig: string; callbackUrl?: string; callbackToken?: string };
export function cliArgument(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
export async function consumeJitConfig(configPath: string, runnerRoot: string): Promise<number> {
  const bytes = await readFile(configPath); const encoded = bytes.toString("utf8").trim();
  if (!encoded) { bytes.fill(0); throw new Error("jit config missing"); }
  RunnerJitConfig.shape.encodedJitConfig.parse(encoded);
  const runnerCommand = Bun.env.WHITESMITH_RUNNER_COMMAND ?? "./run.sh";
  const command = process.platform === "win32" ? (runnerCommand.endsWith(".sh") ? ["bash", runnerCommand] : ["cmd.exe", "/c", runnerCommand]) : [runnerCommand];
  const runner = Bun.spawn(command, { cwd: runnerRoot, env: { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: encoded }, stdout: "ignore", stderr: "ignore" }); bytes.fill(0); return await runner.exited;
}
export async function runOneTimeJitBootstrap(configPath: string, runnerRoot: string): Promise<void> { try { if (await consumeJitConfig(configPath, runnerRoot) !== 0) throw new Error("runner exited unsuccessfully"); } finally { await unlink(configPath).catch(() => undefined); } }
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
  const exitCode = await consumeGuestJitConfig(bootstrap.encodedJitConfig, runnerRoot, platform);
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
export async function consumeGuestJitConfig(encoded: string, runnerRoot: string, platform: "windows-x64" | "linux-x64"): Promise<number> { RunnerJitConfig.shape.encodedJitConfig.parse(encoded); const runner = Bun.spawn(runnerCommandForPlatform(platform), { cwd: runnerRoot, env: { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: encoded }, stdout: "ignore", stderr: "ignore" }); return runner.exited; }
