import { unlink, readFile } from "node:fs/promises";
import { RunnerJitConfig } from "@whitesmith/contracts";

export type RunnerOutputSink = (chunk: string) => void | Promise<void>;

async function pumpOutput(stream: ReadableStream<Uint8Array>, sink: RunnerOutputSink): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) await sink(text);
  }
  const remainder = decoder.decode();
  if (remainder) await sink(remainder);
}

export async function consumeJitConfig(configPath: string, runnerRoot: string, output: RunnerOutputSink = chunk => { process.stdout.write(chunk); }): Promise<void> {
  const bytes = await readFile(configPath);
  try {
    const encoded = bytes.toString("utf8").trim();
    if (!encoded) throw new Error("jit config missing");
    RunnerJitConfig.shape.encodedJitConfig.parse(encoded);
    const runner = Bun.spawn(["./run.sh"], { cwd: runnerRoot, env: { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: encoded }, stdout: "pipe", stderr: "pipe" });
    bytes.fill(0);
    const [exitCode] = await Promise.all([runner.exited, pumpOutput(runner.stdout, output), pumpOutput(runner.stderr, output)]);
    if (exitCode !== 0) throw new Error("runner exited unsuccessfully");
  } finally {
    bytes.fill(0);
  }
}

export async function runOneTimeJitBootstrap(configPath: string, runnerRoot: string, output?: RunnerOutputSink): Promise<void> {
  try { await consumeJitConfig(configPath, runnerRoot, output); } finally { await unlink(configPath).catch(() => undefined); }
}
