import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createDb, migrateDatabase, type DatabaseClient } from "../packages/db/src/index.ts";
import { applyWorkflowJobWebhook, configureRunLifecycle } from "../apps/control-plane/src/runs.ts";
import { listReplayableWorkerCommands } from "../apps/control-plane/src/worker-dispatch.ts";

const databaseUrl = Bun.env.MARS_E2E_DATABASE_URL;
let sql: DatabaseClient | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;
  sql = createDb(databaseUrl);
  await migrateDatabase(sql);
  configureRunLifecycle(sql);
});

afterAll(async () => { await sql?.end({ timeout: 1 }); });

test.skipIf(!databaseUrl)("queued webhook becomes a real lease and encrypted worker dispatch", async () => {
  if (!sql) return;
  const db = sql;
  const organizationId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  const poolId = crypto.randomUUID();
  const [encryption] = [generateKeyPairSync("x25519")];
  const workerPublicKey = encryption.publicKey.export({ format: "pem", type: "spki" }).toString();
  const [org] = await db`insert into organizations (id, github_org_id, login) values (${organizationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'e2e-org') returning id`;
  await db`insert into dashboard_installations (id, organization_id, github_installation_id, state, repository_selection) values (${installationId}, ${org.id}, ${Math.floor(Math.random() * 1_000_000_000)}, 'approved', 'selected')`;
  await db`insert into dashboard_repositories (id, organization_id, installation_id, github_repository_id, name, full_name, visibility, available) values (${repositoryId}, ${org.id}, ${installationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'repo', 'e2e-org/repo', 'private', true)`;
  await db`insert into workers (id, name, platform, admission_state, connection_state, configuration_state, encryption_public_key, limits, vm_uuid, machine_uuid) values (${workerId}, 'e2e-worker', 'linux-x64', 'adopted', 'online', 'ready', ${workerPublicKey}, ${JSON.stringify({ maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4096, maxStorageBytesPerPod: 8192, maxConcurrentPods: 1 })}, ${crypto.randomUUID()}, ${crypto.randomUUID()})`;
  await db`insert into runner_pools (id, organization_id, worker_id, name, platform, driver, image_digest, resources, labels, trigger_label, enabled) values (${poolId}, ${org.id}, ${workerId}, 'e2e', 'linux-x64', 'linux-libvirt-vm', 'ubuntu@sha256:' || repeat('a', 64), ${JSON.stringify({ vcpu: 1, memoryBytes: 1024, storageBytes: 2048, concurrency: 1 })}, ${JSON.stringify(['self-hosted', 'linux', 'x64', 'mars-e2e'])}, 'mars-e2e', true)`;

  const accepted = await applyWorkflowJobWebhook({ action: 'queued', installation: { id: (await db`select github_installation_id from dashboard_installations where id=${installationId}`)[0].github_installation_id }, repository: { id: (await db`select github_repository_id from dashboard_repositories where id=${repositoryId}`)[0].github_repository_id, name: 'repo', full_name: 'e2e-org/repo' }, workflow_job: { id: 987654321, run_id: 123456789, run_number: 1, name: 'build', status: 'queued', labels: ['self-hosted', 'linux', 'x64', 'mars-e2e'] } });
  expect(accepted).toBe(true);

  const dispatched: unknown[] = [];
  const result = await runQueuedJobReconciliation({
    db,
    installationToken: async () => "installation-token",
    githubFetchForInstallation: () => async (_input, init) => { expect(init?.method).toBe("POST"); return Response.json({ encoded_jit_config: "encoded-jit-config" }); },
    dispatcher: { dispatch: async (command) => { dispatched.push(command); return {} as never; } },
  });
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(dispatched).toHaveLength(1);
  const [lease] = await db`select state, github_job_id, expires_at from runner_leases where github_job_id=987654321`;
  expect(lease.state).toBe('dispatched');
  expect(new Date(lease.expires_at).getTime() - Date.now()).toBeGreaterThan(5 * 60_000);
});
test.skipIf(!databaseUrl)("replay filters expired creates and deduplicates terminal stops", async () => {
  if (!sql) return;
  const db = sql;
  const organizationId = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  const poolId = crypto.randomUUID();
  const liveLeaseId = crypto.randomUUID();
  const expiredLeaseId = crypto.randomUUID();
  const terminalLeaseId = crypto.randomUUID();
  const now = Date.now();
  await db`insert into organizations (id, github_org_id, login) values (${organizationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'replay-e2e')`;
  await db`insert into workers (id, name, platform, admission_state, connection_state, configuration_state, limits) values (${workerId}, 'replay-e2e-worker', 'windows-x64', 'adopted', 'offline', 'ready', ${JSON.stringify({})})`;
  await db`insert into runner_pools (id, organization_id, worker_id, name, platform, driver, image_digest, resources, labels, trigger_label, enabled) values (${poolId}, ${organizationId}, ${workerId}, 'replay-e2e-pool', 'windows-x64', 'windows-hyperv-container', 'sha256:' || repeat('b', 64), ${JSON.stringify({})}, ${JSON.stringify([])}, 'replay-e2e', true)`;
  const lease = (id: string, state: string, expiresAt: Date) => db`insert into runner_leases (id, organization_id, pool_id, worker_id, routing_key, state, requested, nonce, expires_at) values (${id}, ${organizationId}, ${poolId}, ${workerId}, 'replay-e2e', ${state}, ${JSON.stringify({})}, ${id}, ${expiresAt})`;
  await lease(liveLeaseId, "dispatched", new Date(now + 60_000));
  await lease(expiredLeaseId, "dispatched", new Date(now - 60_000));
  await lease(terminalLeaseId, "completed", new Date(now - 60_000));
  const command = (id: string, type: string, leaseId: string, occurredAt: Date) => db`insert into commands (id, version, type, worker_id, lease_id, occurred_at, payload, state) values (${id}, 1, ${type}, ${workerId}, ${leaseId}, ${occurredAt}, ${JSON.stringify({})}, 'pending')`;
  const liveCreateId = crypto.randomUUID();
  const expiredCreateId = crypto.randomUUID();
  await command(liveCreateId, "windows-container.create_lease", liveLeaseId, new Date(now - 3_000));
  await command(expiredCreateId, "windows-container.create_lease", expiredLeaseId, new Date(now - 2_000));
  const olderStopId = crypto.randomUUID();
  const newerStopId = crypto.randomUUID();
  await command(olderStopId, "windows-container.stop_lease", terminalLeaseId, new Date(now - 2_000));
  await command(newerStopId, "windows-container.stop_lease", terminalLeaseId, new Date(now - 1_000));
  try {
    const replay = await listReplayableWorkerCommands(db, workerId);
    expect(replay.map(({ id }) => id)).toEqual([liveCreateId, newerStopId]);
    expect(replay.map(({ id }) => id)).not.toContain(expiredCreateId);
    expect(replay).toHaveLength(2);
    expect(replay.some((item) => item.leaseId === liveLeaseId && item.type === "windows-container.create_lease")).toBe(true);
    expect(replay.some((item) => item.leaseId === terminalLeaseId && item.id === newerStopId)).toBe(true);
  } finally {
    await db`delete from commands where worker_id=${workerId}`;
    await db`delete from runner_leases where worker_id=${workerId}`;
    await db`delete from runner_pools where id=${poolId}`;
    await db`delete from workers where id=${workerId}`;
    await db`delete from organizations where id=${organizationId}`;
  }
});
