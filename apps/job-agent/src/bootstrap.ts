import { unlink, readFile } from "node:fs/promises";
import { RunnerJitConfig } from "@whitesmith/contracts";

type GuestBootstrap = { version: 1; leaseId: string; nonce: string; encodedJitConfig: string; callbackUrl?: string; callbackToken?: string };
export async function consumeJitConfig(configPath: string, runnerRoot: string): Promise<number> {
  const bytes = await readFile(configPath); const encoded = bytes.toString("utf8").trim();
  if (!encoded) { bytes.fill(0); throw new Error("jit config missing"); }
  RunnerJitConfig.shape.encodedJitConfig.parse(encoded);
  const runnerCommand = Bun.env.WHITESMITH_RUNNER_COMMAND ?? "./run.sh";
  const command = process.platform === "win32" ? (runnerCommand.endsWith(".sh") ? ["bash", runnerCommand] : ["cmd.exe", "/c", runnerCommand]) : [runnerCommand];
  const runner = Bun.spawn(command, { cwd: runnerRoot, env: { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: encoded }, stdout: "ignore", stderr: "ignore" }); bytes.fill(0); return await runner.exited;
}
export async function runOneTimeJitBootstrap(configPath: string, runnerRoot: string): Promise<void> { try { if (await consumeJitConfig(configPath, runnerRoot) !== 0) throw new Error("runner exited unsuccessfully"); } finally { await unlink(configPath).catch(() => undefined); } }
export async function runGuestService(platform: "windows-x64" | "linux-x64", bootstrapPath: string, runnerRoot: string): Promise<void> {
  const raw = await readFile(bootstrapPath, "utf8"); await unlink(bootstrapPath); const bootstrap = JSON.parse(raw) as GuestBootstrap;
  if (bootstrap.version !== 1 || !bootstrap.leaseId || !bootstrap.nonce || !bootstrap.encodedJitConfig) throw new Error("guest bootstrap invalid");
  const exitCode = await consumeJitConfigFromEncoded(bootstrap.encodedJitConfig, runnerRoot, platform);
  if (bootstrap.callbackUrl || bootstrap.callbackToken) {
    if (!bootstrap.callbackUrl || !bootstrap.callbackToken) throw new Error("guest bootstrap callback invalid");
    const response = await fetch(bootstrap.callbackUrl, { method: "POST", headers: { authorization: `Bearer ${bootstrap.callbackToken}`, "content-type": "application/json" }, body: JSON.stringify({ leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, exitCode }) });
    if (!response.ok) throw new Error(`lease callback failed: ${response.status}`);
  }
  const shutdown = platform === "windows-x64" ? ["shutdown.exe", "/s", "/t", "0"] : ["systemctl", "poweroff"];
  Bun.spawn(shutdown, { stdout: "ignore", stderr: "ignore" });
}
async function consumeJitConfigFromEncoded(encoded: string, runnerRoot: string, platform: "windows-x64" | "linux-x64"): Promise<number> { RunnerJitConfig.shape.encodedJitConfig.parse(encoded); const runner = Bun.spawn([platform === "windows-x64" ? "run.cmd" : "./run.sh"], { cwd: runnerRoot, env: { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: encoded }, stdout: "ignore", stderr: "ignore" }); return runner.exited; }
