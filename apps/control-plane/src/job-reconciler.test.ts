import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import type { DatabaseClient } from "@mars/db";
import { candidateWorkerFromRow, excludedPoolReason, getLiveDispatchPools, runQueuedJobReconciliation } from "./job-reconciler.ts";
import { configureRunLifecycle } from "./runs.ts";
import { fits, reason, type Candidate } from "./scheduler.ts";
import { parseRunnerLabels } from "@mars/contracts";
import { openLeaseBootstrap } from "./lease-dispatch.ts";

const windowsEvidence = { capabilities: [{ driver: "windows-hyperv-container", guestPlatform: "windows-x64", ready: true, imageDigest: "sha256:image", remediation: null }] };
const row = {
  worker_admission_state: "adopted",
  worker_connection_state: "online",
  worker_configuration_state: "ready",
  worker_configuration_revision: "current",
  worker_applied_configuration_revision: "current",
  worker_limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
  platform: "windows-x64",
  driver: "windows-hyperv-container",
  imageDigest: "sha256:image",
  worker_doctor: { doctor: windowsEvidence },
};

function candidate(worker: Candidate["worker"]): Candidate {
  return {
    worker,
    pool: { platform: "windows-x64", enabled: true, resources: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" },
    requestedLabels: ["mars-windows-x64-2vcpu-4g"],
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

test("parses composite CPU and memory routing labels", () => {
  expect(parseRunnerLabels(["MARS-WINDOWS-X64-10VCPU-15G"])).toMatchObject([{
    original: "MARS-WINDOWS-X64-10VCPU-15G",
    route: "mars-windows-x64",
    vcpu: 10,
    memoryGiB: 15,
    memoryBytes: 15 * 1024 ** 3,
  }]);
});

test("reports resource ceiling for a connected worker below the requested limits", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_doctor: windowsEvidence, worker_limits: { maxVcpuPerPod: 8, maxMemoryBytesPerPod: 15 * 1024 ** 3, maxStorageBytesPerPod: 50 * 1024 ** 3, maxConcurrentPods: 1 } });
  const value = candidate(worker);
  value.pool.resources = { vcpu: 16, memoryBytes: 20 * 1024 ** 3, storageBytes: 50 * 1024 ** 3, concurrency: 1 };
  value.requestedLabels = ["mars-windows-x64-10vcpu-15g"];
  expect(fits(value)).toBe(false);
  expect(reason(value)).toBe("resource_ceiling");
});

test("returns a complete report when no queued jobs are available", async () => {
  const db = (async () => []) as never;
  const result = await runQueuedJobReconciliation({
    db,
    contractVersion: "0.1.0",
    installationToken: async () => "",
    dispatcher: { dispatch: async () => {} },
    githubFetchForInstallation: () => fetch,
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 0 });
});

test("preflights unordered labels and marks the lease dispatched before sending, releasing failed sends", async () => {
  const events: string[] = [];
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const workerEncryptionPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
  const workerEncryptionPrivateKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  let leaseState = "reserved", runStatus = "in_progress", githubRunStatus = "queued";
  let failSend = false;
  let db: DatabaseClient;
  db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [{ jobId: 42, runId: "run", githubRunId: 77, runAttempt: 1, runStatus, githubRepositoryId: 123, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-any-2vcpu-4g", "mars-windows-x64-2vcpu-4g"] }];
    if (query.includes('p.id as "poolid"')) return [{
      poolId: "pool",
      organizationId: "org",
      workerId: "worker",
      workerName: "D2E0B2D7893B",
      enabled: true,
      platform: "windows-x64",
      driver: "windows-hyperv-container",
      imageDigest: "sha256:stale-pool-image",
      resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 },
      labels: ["mars-windows-x64"],
      triggerLabel: "mars-windows-x64",
      admissionState: "adopted",
      connectionState: "online",
      configurationState: "ready",
      configurationRevision: "current",
      appliedConfigurationRevision: "current",
      limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
      doctor: { doctor: windowsEvidence },
      encryptionPublicKey: workerEncryptionPublicKey,
      active: 0,
    }];
    if (query.includes("insert into runner_leases")) {
      leaseState = "reserved";
      events.push("reserve");
      return [{ id: "11111111-1111-4111-8111-111111111111", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 1, concurrency: 1 }, jobId: 42 }];
    }
    if (query.includes("update runner_leases set runner_id=")) {
      expect(leaseState).toBe("reserved");
      events.push("record-runner");
      return [{ id: "lease" }];
    }
    if (query.includes("update runner_leases set state='dispatched'")) {
      expect(leaseState).toBe("reserved");
      leaseState = "dispatched";
      events.push("mark-dispatched");
      return [{ id: "lease" }];
    }
    if (query.includes("update runner_leases set state='failed'")) {
      expect(["reserved", "dispatched"]).toContain(leaseState);
      leaseState = "failed";
      events.push("release");
      return [];
    }
    if (query.includes("select id,organization_id from dashboard_installations")) return [{ id: "installation", organization_id: "org" }];
    if (query.includes("select id from dashboard_repositories")) return [{ id: "repo" }];
    if (query.includes("update dashboard_runs set status='queued'")) { runStatus = "queued"; return []; }
    if (query.includes("insert into dashboard_runs")) return [{ id: "run" }];
    if (query.includes("insert into dashboard_jobs")) return [{ id: "dashboard-job" }];
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 }, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 }, doctor: { capacity: { freeVcpu: 2, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 8 } } }];
    if (query.includes("from runner_leases")) return [];
    if (query.includes("select id from dashboard_jobs")) return [{ id: "22222222-2222-4222-8222-222222222222" }];
    return [];
  }) as unknown as DatabaseClient, { begin: async (fn: (tx: DatabaseClient) => unknown) => fn(db) });
  configureRunLifecycle(db as never);
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/actions/jobs/42")) {
      events.push("preflight");
      expect(init?.method).toBeUndefined();
      return Response.json({ id: 42, run_id: 77, run_attempt: 1, status: "queued", name: "build", labels: ["MARS-WINDOWS-X64-2VCPU-4G", "mars-any-2vcpu-4g"], created_at: "2026-08-22T10:31:46Z" });
    }
    if (url.endsWith("/actions/runs/77/attempts/1")) {
      events.push("verify-run");
      return Response.json({ id: 77, run_attempt: 1, run_number: 77, status: githubRunStatus, conclusion: githubRunStatus === "completed" ? "success" : null, name: "CI", created_at: "2026-08-22T10:31:46Z", updated_at: "2026-08-22T10:32:00Z" });
    }
    events.push("jit");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).name).toMatch(/^D2E0B2D7893B-windows-x64-[0-9a-f-]{36}$/);
    return new Response(JSON.stringify({ encoded_jit_config: "encoded-config", runner: { id: 987 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const dispatcher = { dispatch: async (input: { payload: Record<string, unknown> }) => {
    expect(leaseState).toBe("dispatched");
    const envelope = openLeaseBootstrap(input.payload.bootstrapCiphertext as Parameters<typeof openLeaseBootstrap>[0], workerEncryptionPrivateKey);
    expect(envelope.imageDigest).toBe(windowsEvidence.capabilities[0]!.imageDigest);
    events.push("dispatch");
    if (failSend) throw new Error("worker socket send failed");
  } };
  const result = await runQueuedJobReconciliation({
    db,
    contractVersion: "0.1.0",
    installationToken: async () => "token",
    githubFetchForInstallation: () => fetcher,
    dispatcher,
  });
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(events).toEqual(["reserve", "preflight", "jit", "record-runner", "mark-dispatched", "dispatch"]);
  runStatus = "completed";
  events.length = 0;
  const recovered = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => fetcher, dispatcher });
  expect(recovered).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(runStatus).toBe("queued");
  expect(events).toEqual(["reserve", "preflight", "verify-run", "jit", "record-runner", "mark-dispatched", "dispatch"]);
  failSend = true;
  events.length = 0;
  const failed = await runQueuedJobReconciliation({
    db, contractVersion: "0.1.0", installationToken: async () => "token",
    githubFetchForInstallation: () => fetcher, dispatcher,
  });
  expect(failed).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 1 });
  expect(leaseState).toBe("failed");
  expect(events).toEqual(["reserve", "preflight", "jit", "record-runner", "mark-dispatched", "dispatch", "release"]);
  runStatus = "completed";
  githubRunStatus = "completed";
  events.length = 0;
  const terminal = await runQueuedJobReconciliation({ db, contractVersion: "0.1.0", installationToken: async () => "token", githubFetchForInstallation: () => fetcher, dispatcher });
  expect(terminal).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(events).toEqual(["reserve", "preflight", "verify-run", "release"]);
});

test("does not reserve or dispatch when exact GitHub job preflight reports 404", async () => {
  const events: string[] = [];
  const { publicKey } = generateKeyPairSync("x25519");
  const workerEncryptionPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
  let db: DatabaseClient;
  db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [{ jobId: 42, runId: "run", githubRunId: 77, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] }];
    if (query.includes('p.id as "poolid"')) {
      events.push("candidates");
      return [{
      poolId: "pool",
      organizationId: "org",
      workerId: "worker",
      enabled: true,
      platform: "windows-x64",
      driver: "windows-hyperv-container",
      imageDigest: "sha256:image",
      resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 },
      labels: ["mars-windows-x64"],
      triggerLabel: "mars-windows-x64",
      admissionState: "adopted",
      connectionState: "online",
      configurationState: "ready",
      configurationRevision: "current",
      appliedConfigurationRevision: "current",
      limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
      doctor: windowsEvidence,
      encryptionPublicKey: workerEncryptionPublicKey,
      active: 0,
    }];
    }
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 }, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 }, doctor: { capacity: { freeVcpu: 2, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 8 } } }];
    if (query.includes("from runner_leases")) return [];
    if (query.includes("insert into runner_leases")) {
      events.push("reserve");
      return [{ id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 1, concurrency: 1 }, jobId: 42 }];
    }
    return [];
  }) as unknown as DatabaseClient, { begin: async (fn: (tx: DatabaseClient) => unknown) => fn(db) });
  const fetcher = async (input: RequestInfo | URL) => {
    events.push(`github:${String(input)}`);
    return new Response(null, { status: 404 });
  };
  const result = await runQueuedJobReconciliation({
    db,
    contractVersion: "0.1.0",
    installationToken: async () => "token",
    githubFetchForInstallation: () => fetcher,
    dispatcher: { dispatch: async () => { events.push("dispatch"); } },
  });

  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(events).toHaveLength(3);
  expect(events[0]).toBe("candidates");
  expect(events[1]).toBe("reserve");
  expect(events[2]).toContain("/actions/jobs/42");
  expect(events).not.toContain("dispatch");
});
test("fails closed when exact GitHub preflight returns an unknown status", async () => {
  const events: string[] = [];
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [{ jobId: 42, runId: "run", githubRunId: 77, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] }];
    if (query.includes('p.id as "poolid"')) events.push("candidates");
    if (query.includes("insert into runner_leases")) events.push("reserve");
    return [];
  }) as unknown as DatabaseClient, { begin: async () => [] });
  const fetcher = async () => Response.json({ id: 42, run_id: 77, run_attempt: 1, status: "waiting", name: "build", labels: ["mars-windows-x64-2vcpu-4g"], created_at: "2026-08-22T10:31:46Z" });

  const result = await runQueuedJobReconciliation({
    db,
    contractVersion: "0.1.0",
    installationToken: async () => "token",
    githubFetchForInstallation: () => fetcher,
    dispatcher: { dispatch: async () => { events.push("dispatch"); } },
  });

  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(events).toEqual(["candidates"]);
});

test("skips all queued preflight requests while an installation is cooling down", async () => {
  const calls: string[] = [];
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [
      { jobId: 42, runId: "run-42", githubRunId: 77, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] },
      { jobId: 43, runId: "run-43", githubRunId: 78, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] },
    ];
    if (query.includes("p.id as")) calls.push("candidates");
    return [];
  }) as unknown as DatabaseClient, { begin: async () => [] });

  const result = await runQueuedJobReconciliation({
    db,
    contractVersion: "0.1.0",
    installationToken: async () => "token",
    githubFetchForInstallation: () => async () => {
      calls.push("github");
      throw new Error("must not fetch while cooling down");
    },
    installationBlocked: (installationId) => installationId === 7,
    dispatcher: { dispatch: async () => { calls.push("dispatch"); } },
  });

  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 2, failed: 0 });
  expect(calls).toEqual(["candidates"]);
});

test("stops preflighting an installation after one rate-limit response", async () => {
  const githubJobs: number[] = [];
  const calls: string[] = [];
  const rateLimitError = Object.assign(new Error("github_rate_limited"), { code: "github_rate_limited" });
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [
      { jobId: 42, runId: "run-42", githubRunId: 77, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] },
      { jobId: 43, runId: "run-43", githubRunId: 78, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] },
      { jobId: 44, runId: "run-44", githubRunId: 79, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 8, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] },
    ];
    if (query.includes("p.id as")) return [{
      poolId: "pool",
      workerId: "worker",
      enabled: true,
      platform: "windows-x64",
      driver: "windows-hyperv-container",
      imageDigest: "sha256:image",
      resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 },
      labels: ["mars-windows-x64"],
      triggerLabel: "mars-windows-x64",
      admissionState: "adopted",
      connectionState: "online",
      configurationState: "ready",
      configurationRevision: "current",
      appliedConfigurationRevision: "current",
      limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
      doctor: windowsEvidence,
      encryptionPublicKey: "",
      active: 0,
    }];
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 }, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 }, doctor: { capacity: { freeVcpu: 2, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 8 } } }];
    if (query.includes("insert into runner_leases")) return [{ id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 1, concurrency: 1 }, jobId: 42 }];
    return [];
  }) as unknown as DatabaseClient, { begin: async (fn: (tx: DatabaseClient) => unknown) => fn(db) });

  const result = await runQueuedJobReconciliation({
    db,
    contractVersion: "0.1.0",
    installationToken: async () => "token",
    githubFetchForInstallation: (installationId) => async (input) => {
      const jobId = Number(String(input).match(/actions\/jobs\/(\d+)$/)?.[1]);
      githubJobs.push(jobId);
      if (installationId === 7) throw rateLimitError;
      return Response.json({ id: jobId, run_id: 79, run_attempt: 1, status: "queued", name: "build", labels: installationId === 8 ? ["different"] : ["mars-windows-x64-2vcpu-4g"], created_at: "2026-08-22T10:31:46Z" });
    },
    installationBlocked: () => false,
    dispatcher: { dispatch: async () => { calls.push("dispatch"); } },
  });

  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 2, failed: 1 });
  expect(githubJobs).toEqual([42, 44]);
  expect(calls).toEqual([]);
});
test("persists normalized labels and releases when GitHub queued labels change", async () => {
  let updatedLabels: unknown;
  const events: string[] = [];
  const { publicKey } = generateKeyPairSync("x25519");
  const workerEncryptionPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
  const candidateRow = {
    poolId: "pool",
    workerId: "worker",
    enabled: true,
    platform: "windows-x64",
    driver: "windows-hyperv-container",
    imageDigest: "sha256:image",
    resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 },
    labels: ["mars-windows-x64-2vcpu-4g"],
    triggerLabel: "mars-windows-x64",
    admissionState: "adopted",
    connectionState: "online",
    configurationState: "ready",
    configurationRevision: "current",
    appliedConfigurationRevision: "current",
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
    doctor: windowsEvidence,
    encryptionPublicKey: workerEncryptionPublicKey,
    active: 0,
  };
  const db = Object.assign((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [{ jobId: 42, runId: "run", githubRunId: 77, runAttempt: 1, repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels: ["mars-windows-x64-2vcpu-4g"] }];
    if (query.includes("p.id as")) return [candidateRow];
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: candidateRow.resources, limits: candidateRow.limits, doctor: { capacity: { freeVcpu: 2, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 8 } } }];
    if (query.includes("from runner_leases")) return [];
    if (query.includes("insert into runner_leases")) {
      events.push("reserve");
      return [{ id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 1, concurrency: 1 }, jobId: 42 }];
    }
    if (query.includes("update dashboard_jobs set requested_labels")) updatedLabels = values[0];
    if (query.includes("update runner_leases")) events.push("release");
    return [];
  }) as unknown as DatabaseClient, { begin: async (fn: (tx: DatabaseClient) => unknown) => fn(db) });
  const result = await runQueuedJobReconciliation({
    db,
    contractVersion: "0.1.0",
    installationToken: async () => "token",
    githubFetchForInstallation: () => async (input) => {
      events.push("preflight");
      expect(String(input)).toContain("/actions/jobs/42");
      return Response.json({ id: 42, run_id: 77, run_attempt: 1, status: "queued", name: "build", labels: ["mars-windows-x64-1vcpu-2g"], created_at: "2026-08-22T10:31:46Z" });
    },
    dispatcher: { dispatch: async () => { throw new Error("must not dispatch"); } },
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(updatedLabels).toEqual(["mars-windows-x64-1vcpu-2g"]);
  expect(events).toEqual(["reserve", "preflight", "release"]);
});

test("reports requested labels for a job without a matching pool", async () => {
  const labels = ["mars-linux-arm64-2vcpu-4g", "mars-macos-arm64-4vcpu-8g"];
  const decisions: unknown[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [{ jobId: 42, runId: "run", githubRunId: "35985554985", jobName: "Build and test (Ubuntu)", repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels }];
    if (query.includes('p.id as "poolid"')) return [{
      poolId: "pool", poolName: "Windows pool", workerId: "worker", enabled: true, platform: "windows-x64",
      driver: "windows-hyperv-container", imageDigest: "sha256:image",
      resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 1 },
      labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64",
      admissionState: "adopted", connectionState: "online", configurationState: "ready",
      configurationRevision: "current", appliedConfigurationRevision: "current",
      limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
      doctor: windowsEvidence, active: 0,
    }];
    return [];
  }) as unknown as DatabaseClient;
  const report = await runQueuedJobReconciliation({
    db, contractVersion: "0.1.0", installationToken: async () => "token",
    githubFetchForInstallation: () => async () => { throw new Error("unexpected GitHub request"); },
    dispatcher: { dispatch: async () => { throw new Error("unexpected dispatch"); } },
    onDecision: decision => decisions.push(decision),
  });
  expect(report.skipped).toBe(1);
  expect(decisions).toEqual([{ organizationId: "org", jobId: 42, code: "no_matching_labels", labels, repository: "acme/project", githubRunId: "35985554985", jobName: "Build and test (Ubuntu)", pools: [{ poolId: "pool", poolName: "Windows pool", platform: "windows-x64", workerId: "worker", workerName: "", reason: "no_matching_labels" }] }]);
});

test("identifies configured pools when no worker reaches the candidate query", async () => {
  const decisions: unknown[] = [];
  const labels = ["mars-windows-x64-2vcpu-4g"];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from dashboard_jobs j")) return [{ jobId: 42, runId: "run", repositoryId: "repo", organizationId: "org", installationId: 7, repository: "acme/project", labels }];
    if (query.includes("left join workers w")) return [
      { poolId: "pool-1", poolName: "Windows pool", platform: "windows-x64", enabled: true },
      { poolId: "pool-2", poolName: "Disabled pool", platform: "linux-arm64", enabled: false },
    ];
    return [];
  }) as unknown as DatabaseClient;
  const report = await runQueuedJobReconciliation({
    db, contractVersion: "0.1.0", installationToken: async () => "token",
    githubFetchForInstallation: () => async () => { throw new Error("unexpected GitHub request"); },
    dispatcher: { dispatch: async () => { throw new Error("unexpected dispatch"); } },
    onDecision: decision => decisions.push(decision),
  });
  expect(report.skipped).toBe(1);
  expect(decisions).toEqual([{
    organizationId: "org", jobId: 42, code: "no_eligible_worker_pool", labels,
    pools: [
      { poolId: "pool-1", poolName: "Windows pool", platform: "windows-x64", reason: "no_configured_worker_for_pool" },
      { poolId: "pool-2", poolName: "Disabled pool", platform: "linux-arm64", reason: "pool_disabled" },
    ],
  }]);
});

test("identifies why a configured worker is excluded before pool matching", () => {
  const now = Date.parse("2026-09-29T00:00:00.000Z");
  const pool = {
    enabled: true, workerId: "worker", admissionState: "adopted", draining: false,
    connectionState: "online", configurationState: "ready", configurationRevision: "current",
    appliedConfigurationRevision: "current", lastHeartbeatAt: new Date(now - 5_000),
    doctorObservedAt: new Date(now - 5_000), driver: "windows-hyperv-container",
    platform: "windows-x64", imageDigest: "sha256:expected", doctor: { doctor: windowsEvidence },
  };
  expect(excludedPoolReason(pool, now)).toBe("admissible");
  expect(excludedPoolReason({ ...pool, doctor: { capabilities: [{ ...windowsEvidence.capabilities[0], ready: false }] } }, now)).toBe("worker_runtime_not_ready");
  expect(excludedPoolReason({ ...pool, doctorObservedAt: new Date(now - 61_000) }, now)).toBe("worker_doctor_stale");
  expect(excludedPoolReason({ ...pool, connectionState: "offline" }, now)).toBe("worker_offline");
});

test("current pool snapshot distinguishes a ready worker from a disabled or disconnected one", async () => {
  const fresh = new Date();
  const base = {
    admissionState: "adopted", connectionState: "online", configurationState: "ready",
    configurationRevision: "current", appliedConfigurationRevision: "current", draining: false,
    lastHeartbeatAt: fresh, doctorObservedAt: fresh, doctor: { doctor: windowsEvidence },
    driver: "windows-hyperv-container", platform: "windows-x64", imageDigest: "sha256:image",
    resources: { vcpu: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 8, concurrency: 2 },
    active: 0, enabled: true,
  };
  const db = (async () => [
    { ...base, poolId: "ready", poolName: "Ready", workerId: "ready-worker", workerName: "BEAST" },
    { ...base, poolId: "disconnected", poolName: "Disconnected", workerId: "offline-worker", workerName: "old host" },
    { ...base, poolId: "disabled", poolName: "Disabled", workerId: "other", enabled: false },
    { ...base, poolId: "full", poolName: "Full", workerId: "full-worker", active: 2 },
  ]) as unknown as DatabaseClient;
  const pools = await getLiveDispatchPools(db, ["org"], workerId => workerId !== "offline-worker");
  expect(pools.map(({ reason }) => reason)).toEqual(["admissible", "worker_offline", "pool_disabled", "pool_concurrency"]);
});
