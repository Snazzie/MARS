import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { candidateWorkerFromRow, excludedPoolReason, getLiveDispatchPools, runQueuedJobReconciliation } from "./job-reconciler.ts";
import { configureRunLifecycle } from "./runs.ts";
import { fits, reason, type Candidate } from "./scheduler.ts";
import { parseRunnerLabels } from "@mars/contracts";
import { openLeaseBootstrap } from "./lease-dispatch.ts";

const windowsEvidence = { capabilities: [{ driver: "windows-hyperv-container", guestPlatform: "windows-x64", ready: true, imageDigest: "sha256:image", remediation: null }] };
const row = {
  worker_admission_state: "adopted", worker_connection_state: "online", worker_configuration_state: "ready",
  worker_configuration_revision: "current", worker_applied_configuration_revision: "current",
  worker_limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
  platform: "windows-x64", driver: "windows-hyperv-container", imageDigest: "sha256:image", worker_doctor: { doctor: windowsEvidence },
};
function candidate(worker: Candidate["worker"]): Candidate {
  return { worker, pool: { platform: "windows-x64", enabled: true, resources: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" }, requestedLabels: ["mars-windows-x64-2vcpu-4g"] };
}
const resourceLimits = { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 };
const resources = { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 };
const eligiblePool = (key = "") => ({
  poolId: "pool", poolName: "Windows pool", organizationId: "org", workerId: "worker", workerName: "BEAST", enabled: true,
  platform: "windows-x64", driver: "windows-hyperv-container", imageDigest: "sha256:image", resources, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64",
  admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationRevision: "current", appliedConfigurationRevision: "current",
  limits: resourceLimits, doctor: windowsEvidence, encryptionPublicKey: key, active: 0,
});
const queuedJob = (jobId = 42, installationId = 7) => ({ jobId, runId: `run-${jobId}`, githubRunId: jobId + 35, runAttempt: 1, runStatus: "in_progress", githubRepositoryId: 123, repositoryId: "repo", organizationId: "org", installationId, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"], jobName: "build" });
function reservationRows(name: string) {
  if (name === "lease_eligible_worker_pool") return [{ id: "pool", resources, cpuMode: "shared", platform: "windows-x64", driver: "windows-hyperv-container", imageDigest: "sha256:image", workerId: "worker", hostPlatform: "windows-x64", contractVersion: "1.0.0", limits: resourceLimits, doctor: { capacity: { freeVcpu: 2, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 8 } } }];
  if (name === "lease_active_pool_count") return [{ count: 0 }];
  if (name === "lease_active_worker_capacity") return [{ count: 0, vcpu: 0, memoryBytes: 0, storageBytes: 0 }];
  if (name === "lease_worker_cpu_claims") return [];
  if (name === "lease_reserve_routing_slot") return [{ id: "11111111-1111-4111-8111-111111111111", jobId: 42, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 1, concurrency: 1 }, cpuMode: "shared", cpuIds: null }];
  return [];
}

test("maps desired and applied revisions into scheduler candidates", () => {
  expect(candidateWorkerFromRow(row)).toMatchObject({ configurationRevision: "current", appliedConfigurationRevision: "current" });
});
test("blocks a ready worker whose applied revision is stale", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_applied_configuration_revision: "old" });
  expect(fits(candidate(worker))).toBe(false);
  expect(reason(candidate(worker))).toBe("worker_config_applying");
});
test("reports an online database worker without an authenticated socket as offline", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_connection_state: "online" });
  expect(reason(candidate({ ...worker, connectionState: "offline" }))).toBe("worker_offline");
});
test("parses composite CPU and memory routing labels", () => {
  expect(parseRunnerLabels(["MARS-WINDOWS-X64-10VCPU-15G"])).toMatchObject([{ original: "MARS-WINDOWS-X64-10VCPU-15G", route: "mars-windows-x64", vcpu: 10, memoryGiB: 15, memoryBytes: 15 * 1024 ** 3 }]);
});
test("reports resource ceiling for a connected worker below the requested limits", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_doctor: windowsEvidence, worker_limits: { maxVcpuPerPod: 8, maxMemoryBytesPerPod: 15 * 1024 ** 3, maxStorageBytesPerPod: 50 * 1024 ** 3, maxConcurrentPods: 1 } });
  const value = candidate(worker); value.pool.resources = { vcpu: 16, memoryBytes: 20 * 1024 ** 3, storageBytes: 50 * 1024 ** 3, concurrency: 1 }; value.requestedLabels = ["mars-windows-x64-10vcpu-15g"];
  expect(fits(value)).toBe(false); expect(reason(value)).toBe("resource_ceiling");
});
test("returns a complete report when no queued jobs are available", async () => {
  const result = await runQueuedJobReconciliation({ db: preparedTestDatabase(() => []), contractVersion: "0.1.0", installationToken: async () => "", dispatcher: { dispatch: async () => {} }, githubFetchForInstallation: () => fetch });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 0 });
});

test("preflights normalized labels, reserves through prepared lease queries, and releases failed dispatch", async () => {
  const events: string[] = [], { publicKey, privateKey } = generateKeyPairSync("x25519");
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString(), privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  let failSend = false, runStatus = "in_progress", githubRunStatus = "in_progress";
  const db = preparedTestDatabase(name => {
    if (name === "job_reconciler_queued") return [{ ...queuedJob(), runStatus, labels: ["mars-any-2vcpu-4g", "mars-windows-x64-2vcpu-4g"] }];
    if (name === "job_reconciler_candidates") return [{ ...eligiblePool(publicPem), imageDigest: "sha256:stale-pool-image" }];
    if (name === "lease_eligible_worker_pool" || name === "lease_active_pool_count" || name === "lease_active_worker_capacity" || name === "lease_worker_cpu_claims") return reservationRows(name);
    if (name === "job_reconciler_record_runner") { events.push("record-runner"); return [{ id: "lease" }]; }
    if (name === "lease_reserve_routing_slot") { events.push("reserve"); return reservationRows(name); }
    if (name === "job_reconciler_dispatched") { events.push("mark-dispatched"); return [{ id: "lease" }]; }
    if (name === "job_reconciler_release") { events.push("release"); return []; }
    if (name === "job_reconciler_job_id") return [{ id: "22222222-2222-4222-8222-222222222222" }];
    if (name.startsWith("run_lifecycle_")) return [{ id: "run" }];
    return [];
  });
  configureRunLifecycle(db as never);
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/actions/jobs/42")) { events.push("preflight"); expect(init?.method).toBeUndefined(); return Response.json({ id: 42, run_id: 77, run_attempt: 1, status: "queued", name: "build", labels: ["MARS-WINDOWS-X64-2VCPU-4G", "mars-any-2vcpu-4g"], created_at: "2026-08-22T10:31:46Z" }); }
    if (url.endsWith("/actions/runs/77/attempts/1")) { events.push("verify-run"); return Response.json({ id: 77, run_attempt: 1, run_number: 77, status: githubRunStatus, conclusion: githubRunStatus === "completed" ? "success" : null, name: "CI", created_at: "2026-08-22T10:31:46Z", updated_at: "2026-08-22T10:32:00Z" }); }
    events.push("jit"); expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body)).name).toMatch(/^BEAST-windows-x64-[0-9a-f-]{36}$/);
    return Response.json({ encoded_jit_config: "encoded-config", runner: { id: 987 } });
  };
  const dispatcher = { dispatch: async (input: { payload: Record<string, unknown> }) => {
    const envelope = openLeaseBootstrap(input.payload.bootstrapCiphertext as Parameters<typeof openLeaseBootstrap>[0], privatePem);
    expect(envelope.imageDigest).toBe(windowsEvidence.capabilities[0]!.imageDigest); events.push("dispatch"); if (failSend) throw new Error("worker socket send failed");
  } };
  const deps = { db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => fetcher, dispatcher };
  expect(await runQueuedJobReconciliation(deps)).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(events).toEqual(["reserve", "preflight", "jit", "record-runner", "mark-dispatched", "dispatch"]);
  runStatus = "completed"; events.length = 0;
  expect(await runQueuedJobReconciliation(deps)).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(events).toEqual(["reserve", "preflight", "verify-run", "jit", "record-runner", "mark-dispatched", "dispatch"]);
  runStatus = "in_progress"; failSend = true; events.length = 0;
  expect(await runQueuedJobReconciliation(deps)).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 1 });
  expect(events).toEqual(["reserve", "preflight", "jit", "record-runner", "mark-dispatched", "dispatch", "release"]);
  runStatus = "completed"; githubRunStatus = "completed"; events.length = 0;
  expect(await runQueuedJobReconciliation(deps)).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(events).toEqual(["reserve", "preflight", "verify-run", "release"]);
});

test("does not dispatch when exact GitHub job preflight reports 404", async () => {
  const events: string[] = [];
  const db = preparedTestDatabase(name => {
    if (name === "job_reconciler_queued") return [queuedJob()];
    if (name === "job_reconciler_candidates") return [eligiblePool()];
    if (name === "lease_eligible_worker_pool" || name === "lease_active_pool_count" || name === "lease_active_worker_capacity" || name === "lease_worker_cpu_claims" || name === "lease_reserve_routing_slot") return reservationRows(name);
    return [];
  });
  const result = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => async input => { events.push(`github:${String(input)}`); return new Response(null, { status: 404 }); }, dispatcher: { dispatch: async () => { events.push("dispatch"); } } });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(events.some(event => event.includes("/actions/jobs/42"))).toBe(true); expect(events).not.toContain("dispatch");
});

test("fails closed when exact GitHub preflight returns an unknown status", async () => {
  const events: string[] = [];
  const db = preparedTestDatabase(name => {
    if (name === "job_reconciler_queued") return [queuedJob()];
    if (name === "job_reconciler_candidates") return [eligiblePool()];
    if (name === "lease_eligible_worker_pool" || name === "lease_active_pool_count" || name === "lease_active_worker_capacity" || name === "lease_worker_cpu_claims" || name === "lease_reserve_routing_slot") return reservationRows(name);
    return [];
  });
  const result = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => async () => Response.json({ id: 42, run_id: 77, run_attempt: 1, status: "waiting", name: "build", labels: ["mars-windows-x64-2vcpu-4g"], created_at: "2026-08-22T10:31:46Z" }), dispatcher: { dispatch: async () => { events.push("dispatch"); } } });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 1 }); expect(events).not.toContain("dispatch");
});

test("skips queued preflight requests while an installation is cooling down", async () => {
  const calls: string[] = [];
  const db = preparedTestDatabase(name => { if (name === "job_reconciler_queued") return [queuedJob(42), queuedJob(43)]; if (name === "job_reconciler_candidates") calls.push("candidates"); return []; });
  const result = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => async () => { calls.push("github"); throw new Error("must not fetch while cooling down"); }, installationBlocked: id => id === 7, dispatcher: { dispatch: async () => { calls.push("dispatch"); } } });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 2, failed: 0 }); expect(calls).toEqual(["candidates"]);
});

test("stops preflighting an installation after one rate-limit response", async () => {
  const githubJobs: number[] = [], rateLimitError = Object.assign(new Error("github_rate_limited"), { code: "github_rate_limited" });
  const db = preparedTestDatabase(name => { if (name === "job_reconciler_queued") return [queuedJob(42, 7), queuedJob(43, 7), queuedJob(44, 8)]; if (name === "job_reconciler_candidates") return [eligiblePool()]; if (name === "lease_eligible_worker_pool" || name === "lease_active_pool_count" || name === "lease_active_worker_capacity" || name === "lease_worker_cpu_claims" || name === "lease_reserve_routing_slot") return reservationRows(name); return []; });
  const result = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: installationId => async input => { const id = Number(String(input).match(/actions\/jobs\/(\d+)$/)?.[1]); githubJobs.push(id); if (installationId === 7) throw rateLimitError; return Response.json({ id, run_id: 79, run_attempt: 1, status: "queued", name: "build", labels: ["different"], created_at: "2026-08-22T10:31:46Z" }); }, dispatcher: { dispatch: async () => {} } });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 2, failed: 1 }); expect(githubJobs).toEqual([42, 44]);
});

test("persists normalized labels and releases when GitHub queued labels change", async () => {
  const events: string[] = [], { publicKey } = generateKeyPairSync("x25519"), publicPem = publicKey.export({ format: "pem", type: "spki" }).toString(); let updatedLabels: unknown;
  const db = preparedTestDatabase((name, values) => {
    if (name === "job_reconciler_queued") return [queuedJob()]; if (name === "job_reconciler_candidates") return [eligiblePool(publicPem)];
    if (name === "lease_eligible_worker_pool" || name === "lease_active_pool_count" || name === "lease_active_worker_capacity" || name === "lease_worker_cpu_claims") return reservationRows(name);
    if (name === "lease_reserve_routing_slot") { events.push("reserve"); return reservationRows(name); }
    if (name === "job_reconciler_labels") updatedLabels = JSON.parse(String(values.labels)); if (name === "job_reconciler_release") { events.push("release"); return []; } return [];
  });
  const result = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => async () => { events.push("preflight"); return Response.json({ id: 42, run_id: 77, run_attempt: 1, status: "queued", name: "build", labels: ["mars-windows-x64-1vcpu-2g"], created_at: "2026-08-22T10:31:46Z" }); }, dispatcher: { dispatch: async () => { throw new Error("must not dispatch"); } } });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 }); expect(updatedLabels).toEqual(["mars-windows-x64-1vcpu-2g"]); expect(events).toEqual(["reserve", "preflight", "release"]);
});

test("reports requested labels for a job without a matching pool", async () => {
  const labels = ["mars-linux-arm64-2vcpu-4g", "mars-macos-arm64-4vcpu-8g"], decisions: unknown[] = [];
  const db = preparedTestDatabase(name => name === "job_reconciler_queued" ? [{ ...queuedJob(), githubRunId: "35985554985", jobName: "Build and test (Ubuntu)", labels }] : name === "job_reconciler_candidates" ? [eligiblePool()] : []);
  const report = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => async () => { throw new Error("unexpected GitHub request"); }, dispatcher: { dispatch: async () => { throw new Error("unexpected dispatch"); } }, onDecision: decision => decisions.push(decision) });
  expect(report.skipped).toBe(1); expect(decisions).toEqual([{ organizationId: "org", jobId: 42, code: "no_matching_labels", labels, repository: "acme/project", githubRunId: "35985554985", jobName: "Build and test (Ubuntu)", pools: [{ poolId: "pool", poolName: "Windows pool", platform: "windows-x64", workerId: "worker", workerName: "BEAST", reason: "no_matching_labels" }] }]);
});

test("identifies configured pools when no worker reaches the candidate query", async () => {
  const decisions: unknown[] = [], labels = ["mars-windows-x64-2vcpu-4g"];
  const db = preparedTestDatabase(name => name === "job_reconciler_queued" ? [queuedJob()] : name === "job_reconciler_excluded_pools" ? [
    { poolId: "pool-1", poolName: "Windows pool", platform: "windows-x64", enabled: true, workerId: null },
    { poolId: "pool-2", poolName: "Disabled pool", platform: "linux-arm64", enabled: false, workerId: null },
  ] : []);
  const report = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => async () => { throw new Error("unexpected GitHub request"); }, dispatcher: { dispatch: async () => { throw new Error("unexpected dispatch"); } }, onDecision: decision => decisions.push(decision) });
  expect(report.skipped).toBe(1); expect(decisions).toEqual([{ organizationId: "org", jobId: 42, code: "no_eligible_worker_pool", labels, repository: "acme/project", githubRunId: "77", jobName: "build", pools: [{ poolId: "pool-1", poolName: "Windows pool", platform: "windows-x64", reason: "no_configured_worker_for_pool" }, { poolId: "pool-2", poolName: "Disabled pool", platform: "linux-arm64", reason: "pool_disabled" }] }]);
});

test("identifies why a configured worker is excluded before pool matching", () => {
  const now = Date.parse("2026-09-29T00:00:00.000Z"), pool = { enabled: true, workerId: "worker", admissionState: "adopted", draining: false, connectionState: "online", configurationState: "ready", configurationRevision: "current", appliedConfigurationRevision: "current", lastHeartbeatAt: new Date(now - 5_000), doctorObservedAt: new Date(now - 5_000), driver: "windows-hyperv-container", platform: "windows-x64", imageDigest: "sha256:expected", doctor: { doctor: windowsEvidence } };
  expect(excludedPoolReason(pool, now)).toBe("admissible"); expect(excludedPoolReason({ ...pool, doctor: { capabilities: [{ ...windowsEvidence.capabilities[0], ready: false }] } }, now)).toBe("worker_runtime_not_ready"); expect(excludedPoolReason({ ...pool, doctorObservedAt: new Date(now - 61_000) }, now)).toBe("worker_doctor_stale"); expect(excludedPoolReason({ ...pool, connectionState: "offline" }, now)).toBe("worker_offline");
});

test("current pool snapshot distinguishes a ready worker from a disabled or disconnected one", async () => {
  const fresh = new Date(), base = { admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationRevision: "current", appliedConfigurationRevision: "current", draining: false, lastHeartbeatAt: fresh, doctorObservedAt: fresh, doctor: { doctor: windowsEvidence }, driver: "windows-hyperv-container", platform: "windows-x64", imageDigest: "sha256:image", resources: { ...resources, concurrency: 2 }, active: 0, enabled: true };
  const db = preparedTestDatabase(() => [{ ...base, poolId: "ready", poolName: "Ready", workerId: "ready-worker", workerName: "BEAST" }, { ...base, poolId: "disconnected", poolName: "Disconnected", workerId: "offline-worker", workerName: "old host" }, { ...base, poolId: "disabled", poolName: "Disabled", workerId: "other", enabled: false }, { ...base, poolId: "full", poolName: "Full", workerId: "full-worker", active: 2 }]);
  const pools = await getLiveDispatchPools(db, ["org"], workerId => workerId !== "offline-worker"); expect(pools.map(({ reason: poolReason }) => poolReason)).toEqual(["admissible", "worker_offline", "pool_disabled", "pool_concurrency"]);
});
