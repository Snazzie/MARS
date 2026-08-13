import { expect, test } from "bun:test";
import { WorkerDetail } from "@whitesmith/contracts";
import { getOrganizationSettings, listAllRepositories, listAllRuns, listAllPools, listAllWorkers, listWorkers, listPools } from "./dashboard.ts";

test("worker listing normalizes persisted telemetry into the WorkerDetail contract", async () => {
  const db = (async () => [{ id: "86afd915-add3-407c-a6c1-1b46803ef713", organizationId: "c432f22a-16e2-44f8-9a6b-bc00e5de1a7d", name: "mac-worker", platform: "macos-arm64", driver: "tart-vm", admissionState: "adopted", connectionState: "online", configurationState: "ready", fingerprint: "sha256:worker", limits: "{\"maxVcpuPerPod\":2,\"maxMemoryBytesPerPod\":3221225472,\"maxStorageBytesPerPod\":10737418240,\"maxConcurrentPods\":1}", doctor: { doctor: { probe: true, egress: true }, capacity: { freeVcpu: 10, actualVcpu: 10, freeMemoryBytes: 16149077032, actualMemoryBytes: 34359738368, freeStorageBytes: 103244165120, actualStorageBytes: 994610155520 } }, activeSandboxes: 0, draining: false }]) as never;
  const page = await listWorkers(db, "c432f22a-16e2-44f8-9a6b-bc00e5de1a7d");
  expect(() => WorkerDetail.parse(page.items[0])).not.toThrow();
  expect(page.items[0]).toMatchObject({ driver: "tart-vm", doctor: { probe: true }, limits: { maxVcpuPerPod: 2 }, capacity: { vcpu: { actual: 10, free: 10 }, memoryBytes: { actual: 34359738368, free: 16149077032 } } });
});

test("pool listing normalizes PostgreSQL JSONB resources and labels", async () => {
  const db = (async () => [{ id: "pool-1", organizationId: "org-1", workerId: "worker-1", workerName: "worker", name: "default", platform: "linux-x64", driver: "kata-k3s", imageDigest: "ubuntu@sha256:" + "a".repeat(64), resources: "{\"vcpu\":2,\"memoryBytes\":4294967296,\"storageBytes\":10737418240,\"concurrency\":1}", labels: "[\"self-hosted\",\"linux\",\"x64\",\"whitesmith-default\"]", triggerLabel: "whitesmith-default", enabled: true, active: "0" }]) as never;
  const page = await listPools(db, "org-1");
  expect(page.items[0].resources.memoryBytes).toBe(4294967296);
  expect(page.items[0].labels).toEqual(["self-hosted", "linux", "x64", "whitesmith-default"]);
});

test("organization settings convert PostgreSQL numeric values to numbers", async () => {
  const db = (async () => [{ organizationId: "org-1", maxVcpuPerPod: "4", maxMemoryBytesPerPod: "8589934592", maxStorageBytesPerPod: "107374182400", maxConcurrentPods: "2" }]) as never;
  expect(await getOrganizationSettings(db, "org-1")).toEqual({ organizationId: "org-1", maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8589934592, maxStorageBytesPerPod: 107374182400, maxConcurrentPods: 2 });
});

test("all-workspace worker listing includes workers across organizations", async () => {
  const db = (async () => [{ id: "w-1", organizationId: "org-1", name: "linux-one", platform: "linux-x64", admissionState: "adopted", connectionState: "online", configurationState: "ready", fingerprint: "sha256:one", limits: null, doctor: null, activeSandboxes: 0, draining: false }, { id: "w-2", organizationId: "org-2", name: "mac-two", platform: "macos-arm64", admissionState: "pending", connectionState: "offline", configurationState: "unconfigured", fingerprint: "sha256:two", limits: null, doctor: null, activeSandboxes: 0, draining: false }]) as never;
  expect((await listAllWorkers(db, "user-1")).items.map((worker) => worker.organizationId)).toEqual(["org-1", "org-2"]);
});

test("all-workspace listings preserve tenant membership and workspace IDs", async () => {
  const repository = { id: "repo-1", organizationId: "org-1", name: "repo", fullName: "acme/repo", visibility: "private", available: true, approved: true, installationId: "install-1" };
  const run = { id: "run-1", organizationId: "org-1", repositoryId: "repo-1", repositoryName: "repo", runNumber: 1, workflowName: "ci", event: "push", branch: "main", commitSha: "abcdef1", actorLogin: "acme", status: "completed", conclusion: "success", queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0, runtimeBoundary: null };
  const pool = { id: "pool-1", organizationId: "org-1", workerId: "worker-1", workerName: "worker", name: "default", platform: "linux-x64", driver: "kata-k3s", imageDigest: "ubuntu@sha256:" + "a".repeat(64), resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, labels: ["self-hosted"], triggerLabel: "whitesmith", enabled: true, active: 0 };
  const db = (async (strings: TemplateStringsArray) => { const query = strings.join(" "); if (query.includes("runner_pools")) return [pool]; if (query.includes("dashboard_repositories")) return [repository]; if (query.includes("dashboard_runs")) return [run]; return []; }) as never;
  expect((await listAllRepositories(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1" });
  expect((await listAllRuns(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1" });
  expect((await listAllPools(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1" });
});
