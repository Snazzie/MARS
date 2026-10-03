import { mkdtemp, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTerminationEvidence, sanitizeDiagnosticText } from "@mars/contracts";
import type { RuntimeLease } from "./runtime.ts";
import type { DockerResult, DockerRunner } from "./windows-container.ts";

const bundleLimit = 10 * 1024 * 1024;
const missingContainer = /no such container|no such object|container .* not found|does not exist/i;
export function redactContainerDiagnostic(value: string, limit = bundleLimit): string {
  const redacted = sanitizeDiagnosticText(value.replaceAll(/(authorization\s*:\s*bearer\s+)[^\s\r\n]+/gi, "$1[REDACTED]").replaceAll(/([?&](?:token|sig|signature|access_token|oauth_token)=)[^&\s]+/gi, "$1[REDACTED]"), limit);
  if (Buffer.byteLength(redacted) <= limit) return redacted;
  const marker = "\n=== diagnostic output truncated ===\n";
  const prefix = Buffer.from(redacted).subarray(0, Math.max(0, limit - Buffer.byteLength(marker) - 3)).toString("utf8");
  return prefix + (limit >= Buffer.byteLength(marker) ? marker : "");
}
async function boundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = bundleLimit - bytes;
    if (value.length > remaining) truncated = true;
    if (remaining > 0) { const chunk = value.subarray(0, remaining); chunks.push(chunk); bytes += chunk.length; }
  }
  return Buffer.concat(chunks, bytes).toString("utf8") + (truncated ? "\n=== output truncated ===\n" : "");
}
export async function runDocker(args: string[], signal?: AbortSignal): Promise<DockerResult> {
  signal?.throwIfAborted();
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = boundedOutput(child.stdout), stderr = boundedOutput(child.stderr);
  const kill = () => { child.kill(); };
  signal?.addEventListener("abort", kill, { once: true });
  const timeout = args[0] === "wait" ? undefined : setTimeout(kill, 30_000);
  try { return { code: await child.exited, stdout: await stdout, stderr: await stderr }; }
  finally { clearTimeout(timeout); signal?.removeEventListener("abort", kill); }
}
function errorText(error: unknown): string { return redactContainerDiagnostic(error instanceof Error ? error.message : String(error), 900); }
function integer(value: unknown, minimum = 0): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : null; }
function timestamp(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0 ? new Date(value).toISOString() : null; }

// docker wait can disconnect or hang independently of the container. Inspect is
// the fallback observation; a transport failure is never evidence of an OOM kill.
export async function observeContainerCompletion(name: string, runtime: RuntimeLease, docker: DockerRunner, pollMs = 5_000): Promise<number> {
  const started = Date.now();
  const abort = new AbortController();
  let waitResult: DockerResult | undefined;
  let waitError: string | null = null;
  const waiting = Promise.resolve().then(() => docker(["wait", name], abort.signal)).then(result => {
    waitResult = result;
    if (result.code !== 0) waitError = errorText(result.stderr || result.stdout || `docker wait exited ${result.code}`);
  }, error => { waitError = errorText(error); });
  const evidence: RuntimeTerminationEvidence = {
    cause: "service_host_error", exitCode: null, exitObserved: false, elapsedMs: 0,
    childPid: null, servicePid: null, activeProcessCount: null, peakProcessCount: null,
    peakProcessMemoryBytes: null, peakJobMemoryBytes: null, kernelTimeMs: null, userTimeMs: null,
    lastSampleOccurredAt: null, sampleCount: null, samplingGapMs: null,
    container: { status: null, oomKilled: null, error: null, startedAt: null, finishedAt: null,
      memoryLimitBytes: runtime.observed.memoryBytes, memorySwapLimitBytes: null, waitError: null, inspectionError: null },
  };
  const container = evidence.container!;
  const finish = (code: number): number => {
    if (!Number.isSafeInteger(code)) throw new Error("container exit code invalid");
    evidence.cause = "child_exit"; evidence.exitCode = code; evidence.exitObserved = true;
    return code;
  };
  try {
    let inspectImmediately = false;
    for (;;) {
      if (!inspectImmediately) await Promise.race([waiting, Bun.sleep(pollMs)]);
      inspectImmediately = false;
      container.waitError = waitError;
      let observedExit: number | null = null;
      try {
        const result = await docker(["inspect", "--format", '{{json .State}}\n{{json .HostConfig}}', name]);
        if (result.code !== 0) {
          if (missingContainer.test(`${result.stdout} ${result.stderr}`)) evidence.cause = "child_disappeared";
          throw new Error(result.stderr || result.stdout || `docker inspect exited ${result.code}`);
        }
        const lines = result.stdout.trim().split(/\r?\n/);
        const parsed = JSON.parse(lines[0]!);
        const inspection = Array.isArray(parsed) ? parsed[0] : parsed;
        const state = inspection?.State ?? inspection;
        const hostConfig = lines.length > 1 ? JSON.parse(lines[1]!) : inspection?.HostConfig;
        if (!state || typeof state !== "object") throw new Error("docker inspect returned invalid state");
        container.inspectionError = null;
        container.status = typeof state.Status === "string" ? state.Status.slice(0, 64) : null;
        container.oomKilled = typeof state.OOMKilled === "boolean" ? state.OOMKilled : null;
        container.error = typeof state.Error === "string" && state.Error ? errorText(state.Error) : null;
        container.startedAt = timestamp(state.StartedAt); container.finishedAt = timestamp(state.FinishedAt);
        container.memoryLimitBytes = integer(hostConfig?.Memory) ?? runtime.observed.memoryBytes;
        container.memorySwapLimitBytes = integer(hostConfig?.MemorySwap, -1);
        if (state.Running === false) observedExit = integer(state.ExitCode, Number.MIN_SAFE_INTEGER);
        if (state.Running === false && observedExit === null) throw new Error("container exit code invalid");
      } catch (error) {
        container.inspectionError = errorText(error);
        // A successful wait still proves the exit even if final inspect is lost.
        if (waitResult?.code !== 0 || !waitResult.stdout.trim()) throw error;
      }
      if (observedExit !== null) return finish(observedExit);
      if (waitResult?.code === 0) {
        const text = waitResult.stdout.trim();
        if (!/^-?\d+$/.test(text)) throw new Error("container exit code invalid");
        return finish(Number(text));
      }
      // Once wait has settled, only inspect can observe future completion.
      if (waitResult || waitError) { await Bun.sleep(pollMs); inspectImmediately = true; }
    }
  } finally {
    evidence.elapsedMs = Date.now() - started;
    container.waitError = waitError;
    runtime.termination = RuntimeTerminationEvidence.parse(evidence);
    abort.abort();
  }
}
async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return (size > maxBytes ? "=== file tail; earlier output truncated ===\n" : "") + buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}
export async function collectContainerDiagnostics(name: string, platform: "windows" | "linux", docker: DockerRunner): Promise<string> {
  const run = async (args: string[]): Promise<DockerResult> => {
    try { return await docker(args); } catch (error) { return { code: 1, stdout: "", stderr: errorText(error) }; }
  };
  const root = await mkdtemp(join(tmpdir(), "mars-container-diag-"));
  try {
    // Never include Config.Env, Args, or bootstrap/JIT config in the bundle.
    const [inspection, logs] = await Promise.all([
      run(["inspect", "--format", '{{json .State}}\n{{json .HostConfig}}', name]),
      run(["logs", "--timestamps", "--tail", "2000", name]),
    ]);
    const sections = [`=== docker state and limits ===\n${inspection.stdout || inspection.stderr}`, `=== docker logs --timestamps (last 2000 lines) ===\n${logs.stdout || logs.stderr}`];
    const destination = join(root, "runner-diag");
    const copied = await run(["cp", `${name}:${platform === "windows" ? "C:/actions-runner/_diag" : "/opt/actions-runner/_diag"}`, destination]);
    if (copied.code !== 0) sections.push(`=== runner _diag copy failed ===\n${copied.stderr || copied.stdout}`);
    else {
      let remaining = bundleLimit;
      const files = (await readdir(destination, { withFileTypes: true }).catch(error => {
        sections.push(`=== runner _diag unavailable ===\n${errorText(error)}`);
        return [];
      })).filter(file => file.isFile() && /^(Runner|Worker)_.*\.log$/i.test(file.name)).sort((a, b) => b.name.localeCompare(a.name));
      for (const file of files) {
        if (remaining <= 0) break;
        const content = await readBoundedFile(join(destination, file.name), remaining);
        sections.push(`=== runner _diag\\${file.name} ===\n${content}`);
        remaining -= Buffer.byteLength(content);
      }
    }
    if (platform === "windows") {
      const path = join(root, "worker.log");
      const copiedWorker = await run(["cp", `${name}:C:/ProgramData/Mars/logs/worker.log`, path]);
      sections.push(`=== service worker.log ===\n${copiedWorker.code === 0 ? await readBoundedFile(path, bundleLimit).catch(error => errorText(error)) : copiedWorker.stderr || copiedWorker.stdout}`);
    }
    return redactContainerDiagnostic(sections.join("\n"));
  } finally { await rm(root, { recursive: true, force: true }); }
}
let archiveTail = Promise.resolve();
export async function archiveContainerDiagnostics(root: string, leaseId: string, content: string): Promise<void> {
  // Serialize retention so concurrent completions cannot evict each other's writes.
  const work = archiveTail.then(async () => {
    if (!/^[0-9a-f-]{36}$/i.test(leaseId)) throw new Error("invalid diagnostic lease ID");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, `${leaseId}-${crypto.randomUUID()}.log`);
    await writeFile(path, redactContainerDiagnostic(content), { mode: 0o600 });
    const files = (await readdir(root, { withFileTypes: true })).filter(file => file.isFile() && /^[0-9a-f-]{36}-[0-9a-f-]{36}\.log$/i.test(file.name));
    const dated = await Promise.all(files.map(async file => ({ name: file.name, modified: (await stat(join(root, file.name))).mtimeMs })));
    dated.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    for (const file of dated.slice(100)) await rm(join(root, file.name), { force: true });
    console.log("Container diagnostics saved", { leaseId, path });
  });
  archiveTail = work.catch(() => {});
  return work;
}
