import { createTartVmRuntime } from "./tart.ts";

const runtime = createTartVmRuntime("/opt/homebrew/bin/tart");
const vmName = "mars-local-orchestrator-validation";
const base = "mars-worker-base-e2ebdfc4d354b336fe00d729c11a8136a019b8046f41cc183a2fe51b85d18f49";
const output: string[] = [];
const started = Date.now();
try {
  await runtime.clone(base, vmName);
  await runtime.setResources(vmName, { vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes: 20 * 1024 ** 3, concurrency: 1 });
  await runtime.startWithBootstrap(vmName, "synthetic-local-bootstrap");
  const runner = runtime.startRunner(vmName);
  const collect = (async () => {
    for await (const chunk of runner.logs) output.push(chunk);
  })();
  const exitCode = await runner.completion;
  await collect;
  console.log(JSON.stringify({ exitCode, elapsedMs: Date.now() - started, output: output.join("") }));
} finally {
  await runtime.stop(vmName).catch(() => undefined);
  await runtime.remove(vmName).catch(() => undefined);
}
