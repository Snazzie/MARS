import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("output archive path required");
const workRoot = resolve(process.argv[3] ?? join(process.cwd(), "dist", "actions-runner-build-linux-arm64"));
const runnerCommit = "98aabcd429c4e8402406c56ce2d26387fed3b9ce";
const runnerVersion = "2.336.0";
const sourceDir = join(workRoot, "source");
const repoRoot = resolve(import.meta.dir, "..");
const patch = join(repoRoot, "images", "actions-runner", "patches", "0001-mars-worker-cache-registration.patch");

async function run(command: string[], cwd = process.cwd()): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}): ${(stderr || stdout).trim().slice(0, 2_000)}`);
  return stdout.trim();
}

await rm(workRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });
await run(["git", "clone", "--filter=blob:none", "--no-checkout", "https://github.com/actions/runner.git", sourceDir]);
await run(["git", "-C", sourceDir, "checkout", "--detach", runnerCommit]);
if ((await run(["git", "-C", sourceDir, "rev-parse", "HEAD"])) !== runnerCommit) throw new Error("Actions Runner commit verification failed");
await run(["git", "-C", sourceDir, "apply", "--check", patch]);
await run(["git", "-C", sourceDir, "apply", patch]);
if (process.platform === "win32") throw new Error("ARM64 Linux Actions Runner must be built on a Linux host");
await run(["bash", "dev.sh", "layout", "Release"], join(sourceDir, "src"));
const layout = join(sourceDir, "_layout");
const listener = join(layout, "bin", "Runner.Listener");
if (!(await Bun.file(listener).exists())) throw new Error("Runner.Listener was not produced");
const version = (await run([listener, "--version"])).split(/\r?\n/).at(-1)?.trim();
if (version !== runnerVersion) throw new Error(`unexpected Actions Runner version: ${version ?? "missing"}`);
await writeFile(join(layout, ".mars-capabilities.json"), JSON.stringify({ schemaVersion: 1, upstreamVersion: runnerVersion, upstreamCommit: runnerCommit, capabilities: ["mars-worker-cache-registration-v1"] }) + "\n");
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await rm(resolve(outputPath), { force: true });
await run(["tar", "-czf", resolve(outputPath), "-C", layout, "."]);
if (!(await Bun.file(resolve(outputPath)).exists())) throw new Error("runner archive was not produced");
console.log(`Built patched ARM64 Actions Runner ${runnerVersion} from ${runnerCommit} at ${resolve(outputPath)}`);
