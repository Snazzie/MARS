import { unlink, readFile } from "node:fs/promises";
import { RunnerJitConfig } from "@whitesmith/contracts";

export async function consumeJitConfig(configPath: string, runnerRoot: string): Promise<void> {
  const encoded = (await readFile(configPath, "utf8")).trim();
  if (!encoded) throw new Error("jit config missing");
  RunnerJitConfig.shape.encodedJitConfig.parse(encoded);
  const config = Bun.spawn(["./config.sh", "--jitconfig", encoded], { cwd: runnerRoot, stdout: "ignore", stderr: "ignore" });
  if (await config.exited !== 0) throw new Error("runner configuration failed");
  const runner = Bun.spawn(["./run.sh"], { cwd: runnerRoot, stdout: "ignore", stderr: "ignore" });
  if (await runner.exited !== 0) throw new Error("runner exited unsuccessfully");
}

export async function runOneTimeJitBootstrap(configPath: string, runnerRoot: string): Promise<void> {
  try { await consumeJitConfig(configPath, runnerRoot); } finally { await unlink(configPath).catch(() => undefined); }
}
