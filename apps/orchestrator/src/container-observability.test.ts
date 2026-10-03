import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveContainerDiagnostics, collectContainerDiagnostics, observeContainerCompletion } from "./container-observability.ts";
import type { RuntimeLease } from "./runtime.ts";
import type { DockerResult, DockerRunner } from "./windows-container.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function runtime(): RuntimeLease { return { runtimeInstanceId: "container", observed: { vcpu: 1, memoryBytes: 1024, storageBytes: 2048 }, state: "sandbox_attested" }; }

for (const oomKilled of [false, true]) {
  test(`exit 137 retains Docker OOM evidence (${oomKilled}) rather than inferring the cause`, async () => {
    const lease = runtime();
    const docker: DockerRunner = async args => args[0] === "wait"
      ? { code: 0, stdout: "137", stderr: "" }
      : { code: 0, stdout: JSON.stringify({ Running: false, Status: "exited", ExitCode: 137, OOMKilled: oomKilled, Error: "", StartedAt: "2026-10-02T10:00:00Z", FinishedAt: "2026-10-02T10:00:10Z" }) + "\n" + JSON.stringify({ Memory: 1024, MemorySwap: 2048 }), stderr: "" };
    expect(await observeContainerCompletion("container", lease, docker, 1)).toBe(137);
    expect(lease.termination).toMatchObject({ cause: "child_exit", exitObserved: true, exitCode: 137, container: { oomKilled, memoryLimitBytes: 1024, memorySwapLimitBytes: 2048, finishedAt: "2026-10-02T10:00:10.000Z", error: null } });
  });
}
test("a disconnected wait does not terminate a container that is still running", async () => {
  const lease = runtime();
  let inspections = 0;
  const docker: DockerRunner = async args => {
    if (args[0] === "wait") return { code: 1, stdout: "", stderr: "connection reset by peer" };
    return { code: 0, stdout: JSON.stringify(++inspections < 3 ? { Running: true, Status: "running", ExitCode: 0, OOMKilled: false } : { Running: false, Status: "exited", ExitCode: 17, OOMKilled: false }), stderr: "" };
  };
  expect(await observeContainerCompletion("container", lease, docker, 1)).toBe(17);
  expect(lease.termination).toMatchObject({ cause: "child_exit", exitCode: 17, container: { waitError: "connection reset by peer", oomKilled: false } });
});
test("an inspect fallback observes a crash when wait never completes and cancels the waiter", async () => {
  const lease = runtime();
  let cancelled = false;
  const docker: DockerRunner = async (args, signal) => {
    if (args[0] === "wait") { signal!.addEventListener("abort", () => { cancelled = true; }); return Promise.withResolvers<DockerResult>().promise; }
    return { code: 0, stdout: JSON.stringify({ Running: false, Status: "exited", ExitCode: 9, OOMKilled: false }), stderr: "" };
  };
  expect(await observeContainerCompletion("container", lease, docker, 1)).toBe(9);
  expect(cancelled).toBe(true);
  expect(lease.termination?.exitObserved).toBe(true);
});
for (const [detail, cause] of [["No such container: container", "child_disappeared"], ["Cannot connect to the Docker daemon", "service_host_error"]] as const) {
  test(`does not confuse ${cause} with a proven process exit`, async () => {
    const lease = runtime();
    const docker: DockerRunner = async args => ({ code: 1, stdout: "", stderr: args[0] === "wait" ? "connection reset" : detail });
    await expect(observeContainerCompletion("container", lease, docker, 1)).rejects.toThrow(detail);
    expect(lease.termination).toMatchObject({ cause, exitCode: null, exitObserved: false, container: { oomKilled: null, waitError: "connection reset", inspectionError: detail } });
  });
}
test("keeps a proven exit when Docker disappears before final inspection", async () => {
  const lease = runtime();
  const docker: DockerRunner = async args => args[0] === "wait" ? { code: 0, stdout: "-1", stderr: "" } : { code: 1, stdout: "", stderr: "Cannot connect to Docker" };
  expect(await observeContainerCompletion("container", lease, docker, 1)).toBe(-1);
  expect(lease.termination).toMatchObject({ cause: "child_exit", exitObserved: true, exitCode: -1, container: { oomKilled: null, inspectionError: "Cannot connect to Docker" } });
});
test("stopped-container diagnostics retain crash logs without exec and redact credentials before archiving", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-diag-regression-")); roots.push(root);
  const docker: DockerRunner = async args => {
    if (args[0] === "exec") throw new Error("container is stopped");
    if (args[0] === "cp") {
      await mkdir(args[2]!, { recursive: true });
      await writeFile(join(args[2]!, "Runner_failure.log"), "Listener disconnected Authorization: Bearer runner-secret\napi_token=private-token\n");
      await writeFile(join(args[2]!, "Worker_failure.log"), "Build process exhausted memory\n");
    }
    return { code: 0, stdout: args[0] === "logs" ? "runner crashed\n" : "{\"OOMKilled\":true}", stderr: "" };
  };
  const raw = await collectContainerDiagnostics("container", "linux", docker);
  const leaseId = crypto.randomUUID();
  await archiveContainerDiagnostics(root, leaseId, raw);
  const archivedName = (await readdir(root)).find(name => name.startsWith(leaseId))!;
  const archived = await Bun.file(join(root, archivedName)).text();
  expect(archived).toContain("Build process exhausted memory");
  expect(archived).toContain("Listener disconnected Authorization: Bearer [REDACTED]");
  expect(archived).not.toContain("runner-secret");
  expect(archived).not.toContain("private-token");
});
test("diagnostic retention does not grow beyond 100 lease bundles or delete unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-diag-retention-")); roots.push(root);
  await writeFile(join(root, "operator-notes.txt"), "keep");
  for (let index = 0; index < 101; index++) await archiveContainerDiagnostics(root, crypto.randomUUID(), `failure ${index}`);
  const files = await readdir(root);
  expect(files.filter(file => file.endsWith(".log"))).toHaveLength(100);
  expect(await Bun.file(join(root, "operator-notes.txt")).text()).toBe("keep");
});
