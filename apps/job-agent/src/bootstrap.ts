import { unlink, readFile } from "node:fs/promises";
import { RunnerJitConfig } from "@whitesmith/contracts";

export async function consumeJitConfig(configPath: string, runnerRoot: string): Promise<void> {
  const bytes = await readFile(configPath);
  const encoded = bytes.toString("utf8").trim();
  if (!encoded) { bytes.fill(0); throw new Error("jit config missing"); }
  RunnerJitConfig.shape.encodedJitConfig.parse(encoded);
  const runner = Bun.spawn(["./run.sh"], { cwd: runnerRoot, env: { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: encoded }, stdout: "ignore", stderr: "ignore" });
  bytes.fill(0);
  if (await runner.exited !== 0) throw new Error("runner exited unsuccessfully");
}

export async function runOneTimeJitBootstrap(configPath: string, runnerRoot: string): Promise<void> {
  try { await consumeJitConfig(configPath, runnerRoot); } finally { await unlink(configPath).catch(() => undefined); }
}
