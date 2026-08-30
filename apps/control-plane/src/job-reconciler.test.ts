import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import type { DatabaseClient } from "@mars/db";
import { candidateWorkerFromRow, isDispatchableRunStatus, runQueuedJobReconciliation } from "./job-reconciler.ts";
import { fits, parseProvisionLabels, reason, type Candidate } from "./scheduler.ts";

test("keeps queued jobs eligible while their workflow run is in progress", () => {
  expect(isDispatchableRunStatus("queued")).toBe(true);
  expect(isDispatchableRunStatus("in_progress")).toBe(true);
  expect(isDispatchableRunStatus("completed")).toBe(false);
});

const row = {
  worker_admission_state: "adopted",
  worker_connection_state: "online",
  worker_configuration_state: "ready",
  worker_configuration_revision: "current",
  worker_applied_configuration_revision: "current",
  worker_limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
};

function candidate(worker: Candidate["worker"]): Candidate {
  return {
    worker,
    pool: { enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" },
    requestedLabels: ["mars-windows-x64"],
  };
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

test("parses Windows CPU and memory routing labels", () => {
  expect(parseProvisionLabels(["mars-windows-x64", "10VCPU", "15G"])).toEqual({
    routingLabels: ["mars-windows-x64"],
    vcpu: 10,
    memoryBytes: 15 * 1024 ** 3,
  });
});

test("reports resource ceiling for a connected worker below the requested limits", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_doctor: { runtimeReady: true }, worker_limits: { maxVcpuPerPod: 8, maxMemoryBytesPerPod: 15 * 1024 ** 3, maxStorageBytesPerPod: 50 * 1024 ** 3, maxConcurrentPods: 1 } });
  const value = candidate(worker);
  value.pool.resources = { vcpu: 16, memoryBytes: 20 * 1024 ** 3, storageBytes: 50 * 1024 ** 3, concurrency: 1 };
  value.requestedLabels = ["mars-windows-x64", "10VCPU", "15G"];
  expect(fits(value)).toBe(false);
  expect(reason(value)).toBe("resource_ceiling");
});

test("returns a complete report when no queued jobs are available", async () => {
  const db = (async () => []) as never;
  const result = await runQueuedJobReconciliation({
    db,
    installationToken: async () => "",
    dispatcher: { dispatch: async () => {} },
    githubFetchForInstallation: () => fetch,
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 0 });
});

test("reserves, requests JIT configuration, and dispatches an eligible queued job", async () => {
  const events: string[] = [];
  const { publicKey } = generateKeyPairSync("x25519");
  const workerEncryptionPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
  let db: DatabaseClient;
  db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [{ jobId: 42, runId: "run", repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64"] }];
    if (query.includes('p.id as "poolid"')) return [{
      poolId: "pool",
      organizationId: "org",
      workerId: "worker",
      enabled: true,
      platform: "windows-x64",
      driver: "windows-hyperv-container",
      imageDigest: "sha256:image",
      resources: { vcpu: 2, memoryBytes: 4, storageBytes: 8, concurrency: 1 },
      labels: ["mars-windows-x64"],
      triggerLabel: "mars-windows-x64",
      admissionState: "adopted",
      connectionState: "online",
      configurationState: "ready",
      configurationRevision: "current",
      appliedConfigurationRevision: "current",
      limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
      doctor: { runtimeReady: true },
      encryptionPublicKey: workerEncryptionPublicKey,
      active: 0,
    }];
    if (query.includes("insert into runner_leases")) {
      events.push("reserve");
      return [{ id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, jobId: 42 }];
    }
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 2, memoryBytes: 4, storageBytes: 8, concurrency: 1 }, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 }, doctor: { capacity: { freeVcpu: 2, freeMemoryBytes: 4, freeStorageBytes: 8 } } }];
    if (query.includes("from organization_settings")) return [];
    if (query.includes("from runner_leases")) return [];
    if (query.includes("select id from dashboard_jobs")) return [{ id: "dashboard-job" }];
    return [];
  }) as unknown as DatabaseClient, { begin: async (fn: (tx: DatabaseClient) => unknown) => fn(db) });
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    events.push("jit");
    expect(init?.method).toBe("POST");
    return new Response(JSON.stringify({ encoded_jit_config: "encoded-config" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const dispatcher = { dispatch: async () => { events.push("dispatch"); } };
  const result = await runQueuedJobReconciliation({
    db,
    installationToken: async () => "token",
    githubFetchForInstallation: () => fetcher,
    dispatcher,
  });
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(events).toEqual(["reserve", "jit", "dispatch"]);
});
