import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createDb, migrateDatabase, type DatabaseClient } from "../packages/db/src/index.ts";
import { applyWorkflowJobWebhook, configureRunLifecycle } from "../apps/control-plane/src/runs.ts";
import { reconcileExpiredLeasesWithGithub } from "../apps/control-plane/src/lease-reconciliation.ts";
import { getOverview } from "../packages/db/src/dashboard.ts";
import { listReplayableWorkerCommands } from "../apps/control-plane/src/worker-dispatch.ts";
import { runQueuedJobReconciliation } from "../apps/control-plane/src/job-reconciler.ts";

const databaseUrl = Bun.env.MARS_E2E_DATABASE_URL;
let sql: DatabaseClient | undefined;

async function makeWorkerReady(db: DatabaseClient, workerId: string, imageDigest: string) {
  const doctor = { capabilities: [{ driver: "linux-libvirt-vm", guestPlatform: "linux-x64", ready: true, imageDigest }] };
  await db.$client`update workers set guest_platforms=${JSON.stringify(["linux-x64"])}::jsonb, desired_configuration=${JSON.stringify({ selectedDriver: "linux-libvirt-vm" })}::jsonb, configuration_revision='current', applied_configuration_revision='current', last_heartbeat_at=now(), doctor_observed_at=now(), doctor=${JSON.stringify(doctor)}::jsonb where id=${workerId}`;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  sql = createDb(databaseUrl);
  await migrateDatabase(sql);
  configureRunLifecycle(sql);
});

afterAll(async () => { await sql?.$client.end({ timeout: 1 }); });

test.skipIf(!databaseUrl)("queued webhook becomes a real lease and encrypted worker dispatch", async () => {
  if (!sql) return;
  const db = sql;
  const rollback = new Error("rollback fixture");
  try {
    await db.transaction(async () => {
  // E2E fixture setup and assertions use raw SQL intentionally; production reads live in prepared application queries.
  const organizationId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  const poolId = crypto.randomUUID();
  const [encryption] = [generateKeyPairSync("x25519")];
  const workerPublicKey = encryption.publicKey.export({ format: "pem", type: "spki" }).toString();
  const [org] = await db.$client`insert into organizations (id, github_org_id, login) values (${organizationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'e2e-org') returning id`;
  await db.$client`insert into dashboard_installations (id, organization_id, github_installation_id, state, repository_selection) values (${installationId}, ${org.id}, ${Math.floor(Math.random() * 1_000_000_000)}, 'approved', 'selected')`;
  await db.$client`insert into dashboard_repositories (id, organization_id, installation_id, github_repository_id, name, full_name, visibility, available) values (${repositoryId}, ${org.id}, ${installationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'repo', 'e2e-org/repo', 'private', true)`;
  await db.$client`insert into workers (id, name, platform, admission_state, connection_state, configuration_state, encryption_public_key, limits, vm_uuid, machine_uuid) values (${workerId}, 'e2e-worker', 'linux-x64', 'adopted', 'online', 'ready', ${workerPublicKey}, ${JSON.stringify({ maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8192, maxConcurrentPods: 1 })}, ${crypto.randomUUID()}, ${crypto.randomUUID()})`;
  await db.$client`insert into runner_pools (id, organization_id, worker_id, name, platform, driver, image_digest, resources, labels, trigger_label, enabled) values (${poolId}, ${org.id}, ${workerId}, 'e2e', 'linux-x64', 'linux-libvirt-vm', 'ubuntu@sha256:' || repeat('a', 64), ${JSON.stringify({ vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 2048, concurrency: 1 })}, ${JSON.stringify(['mars-linux-x64'])}, 'mars-linux-x64', true)`;
  await makeWorkerReady(db, workerId, `ubuntu@sha256:${"a".repeat(64)}`);

  const requestedLabels = ['mars-linux-x64-2vcpu-4g', 'mars-any-2vcpu-3g'];
  const accepted = await applyWorkflowJobWebhook({ action: 'queued', installation: { id: (await db.$client`select github_installation_id from dashboard_installations where id=${installationId}`)[0].github_installation_id }, repository: { id: (await db.$client`select github_repository_id from dashboard_repositories where id=${repositoryId}`)[0].github_repository_id, name: 'repo', full_name: 'e2e-org/repo' }, workflow_job: { id: 987654321, run_id: 123456789, run_attempt: 1, run_number: 1, name: 'build', status: 'queued', labels: requestedLabels } });
  expect(accepted).toBe(true);
  const dispatched: unknown[] = [];
  const jitLabels: unknown[] = [];
  const result = await runQueuedJobReconciliation({
    db,
    installationToken: async () => "installation-token",
    githubFetchForInstallation: () => async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { labels?: unknown };
        jitLabels.push(body.labels);
        return Response.json({ encoded_jit_config: "encoded-jit-config", runner: { id: 12345 } });
      }
      return Response.json({ id: 987654321, run_id: 123456789, run_attempt: 1, status: "queued", name: "build", labels: requestedLabels, created_at: new Date().toISOString() });
    },
    dispatcher: { dispatch: async (command) => { dispatched.push(command); return {} as never; } },
  });
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(dispatched).toHaveLength(1);
  expect(jitLabels).toEqual([requestedLabels]);
  const [lease] = await db.$client`select state, github_job_id, expires_at, requested, cpu_ids IS NULL AS "sharedCpuIds" from runner_leases where github_job_id=987654321`;
  expect(lease.state).toBe('dispatched');
  expect(lease.requested).toMatchObject({ vcpu: 2, memoryBytes: 4 * 1024 ** 3 });
  expect(lease.sharedCpuIds).toBe(true);
  expect(new Date(lease.expires_at).getTime() - Date.now()).toBeGreaterThan(5 * 60_000);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
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
  await db.$client`insert into organizations (id, github_org_id, login) values (${organizationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'replay-e2e')`;
  await db.$client`insert into workers (id, name, platform, admission_state, connection_state, configuration_state, limits) values (${workerId}, 'replay-e2e-worker', 'windows-x64', 'adopted', 'offline', 'ready', ${JSON.stringify({})})`;
  await db.$client`insert into runner_pools (id, organization_id, worker_id, name, platform, driver, image_digest, resources, labels, trigger_label, enabled) values (${poolId}, ${organizationId}, ${workerId}, 'replay-e2e-pool', 'windows-x64', 'windows-hyperv-container', 'sha256:' || repeat('b', 64), ${JSON.stringify({})}, ${JSON.stringify([])}, 'replay-e2e', true)`;
  const lease = (id: string, state: string, expiresAt: Date) => db.$client`insert into runner_leases (id, organization_id, pool_id, worker_id, routing_key, state, requested, nonce, expires_at) values (${id}, ${organizationId}, ${poolId}, ${workerId}, 'replay-e2e', ${state}, ${JSON.stringify({})}, ${id}, ${expiresAt.toISOString()})`;
  await lease(liveLeaseId, "dispatched", new Date(now + 60_000));
  await lease(expiredLeaseId, "dispatched", new Date(now - 60_000));
  await lease(terminalLeaseId, "completed", new Date(now - 60_000));
  const command = (id: string, type: string, leaseId: string, occurredAt: Date) => db.$client`insert into commands (id, version, type, worker_id, lease_id, occurred_at, payload, state) values (${id}, 1, ${type}, ${workerId}, ${leaseId}, ${occurredAt.toISOString()}, ${JSON.stringify({})}, 'pending')`;
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
    await db.$client`delete from commands where worker_id=${workerId}`;
    await db.$client`delete from runner_leases where worker_id=${workerId}`;
    await db.$client`delete from runner_pools where id=${poolId}`;
    await db.$client`delete from workers where id=${workerId}`;
    await db.$client`delete from organizations where id=${organizationId}`;
  }
});
test.skipIf(!databaseUrl)("reclaims stale provisioning capacity before picking up queued work", async () => {
  if (!sql) return;
  const db = sql;
  const organizationId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  const poolId = crypto.randomUUID();
  const staleJobId = 987654322;
  const queuedJobId = 987654323;
  const [encryption] = [generateKeyPairSync("x25519")];
  const workerPublicKey = encryption.publicKey.export({ format: "pem", type: "spki" }).toString();
  await db.$client`insert into organizations (id, github_org_id, login) values (${organizationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'stale-capacity-e2e')`;
  await db.$client`insert into dashboard_installations (id, organization_id, github_installation_id, state, repository_selection) values (${installationId}, ${organizationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'approved', 'selected')`;
  await db.$client`insert into dashboard_repositories (id, organization_id, installation_id, github_repository_id, name, full_name, visibility, available) values (${repositoryId}, ${organizationId}, ${installationId}, ${Math.floor(Math.random() * 1_000_000_000)}, 'repo', 'stale-capacity-e2e/repo', 'private', true)`;
  await db.$client`insert into workers (id, name, platform, admission_state, connection_state, configuration_state, encryption_public_key, limits, vm_uuid, machine_uuid) values (${workerId}, 'stale-capacity-worker', 'linux-x64', 'adopted', 'online', 'ready', ${workerPublicKey}, ${JSON.stringify({ maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 8192, maxConcurrentPods: 2 })}, ${crypto.randomUUID()}, ${crypto.randomUUID()})`;
  await db.$client`insert into runner_pools (id, organization_id, worker_id, name, platform, driver, image_digest, resources, labels, trigger_label, enabled) values (${poolId}, ${organizationId}, ${workerId}, 'stale-capacity-e2e', 'linux-x64', 'linux-libvirt-vm', 'ubuntu@sha256:' || repeat('c', 64), ${JSON.stringify({ vcpu: 1, memoryBytes: 4 * 1024 ** 3, storageBytes: 2048, concurrency: 2 })}, ${JSON.stringify(['mars-linux-x64'])}, 'mars-linux-x64', true)`;
  await makeWorkerReady(db, workerId, `ubuntu@sha256:${"c".repeat(64)}`);
  const installationGithubId = Number((await db.$client`select github_installation_id from dashboard_installations where id=${installationId}`)[0].github_installation_id);
  const repositoryGithubId = Number((await db.$client`select github_repository_id from dashboard_repositories where id=${repositoryId}`)[0].github_repository_id);
  const createJob = async (jobId: number, status: "queued" | "in_progress") => {
    await applyWorkflowJobWebhook({ action: "queued", installation: { id: installationGithubId }, repository: { id: repositoryGithubId, name: "repo", full_name: "stale-capacity-e2e/repo" }, workflow_job: { id: jobId, run_id: jobId + 1000, run_attempt: 1, run_number: 1, name: "build", status, labels: ["mars-linux-x64-1vcpu-1g"] } });
    if (status === "in_progress") await db.$client`update dashboard_jobs set status='in_progress', started_at=now() where organization_id=${organizationId} and github_job_id=${jobId}`;
  };
  try {
    await createJob(987654324, "in_progress");
    await createJob(staleJobId, "in_progress");
    await createJob(queuedJobId, "queued");
    const createLease = (jobId: number, state: string, expiresAt: Date) => db.$client`insert into runner_leases (id, organization_id, pool_id, worker_id, github_job_id, routing_key, state, requested, nonce, expires_at) values (${crypto.randomUUID()}, ${organizationId}, ${poolId}, ${workerId}, ${jobId}, 'stale-capacity', ${state}, ${JSON.stringify({ vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 })}, ${crypto.randomUUID()}, ${expiresAt.toISOString()})`;
    await createLease(987654324, "busy", new Date(Date.now() + 60_000));
    await createLease(staleJobId, "provisioning", new Date(Date.now() - 60_000));
    const before = await getOverview(db, organizationId, "24h");
    expect(before.running).toBe(2);
    expect(before.queued).toBe(1);
    const stale = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => async (input) => {
      if (String(input).endsWith(`/actions/jobs/${staleJobId}`)) return Response.json({ id: staleJobId, run_id: staleJobId + 1000, run_attempt: 1, status: "in_progress", name: "build", created_at: new Date().toISOString() });
      throw new Error(`unexpected GitHub request: ${String(input)}`);
    } });
    expect(stale.released).toBe(1);
    const dispatched: unknown[] = [];
    const result = await runQueuedJobReconciliation({ db, installationToken: async () => "token", githubFetchForInstallation: () => async (_input, init) => init?.method === "POST" ? Response.json({ encoded_jit_config: "encoded-jit-config", runner: { id: 12346 } }) : Response.json({ id: queuedJobId, run_id: queuedJobId + 1000, run_attempt: 1, status: "queued", name: "build", labels: ["mars-linux-x64-1vcpu-1g"], created_at: new Date().toISOString() }), dispatcher: { dispatch: async (command) => { dispatched.push(command); return {} as never; } } });
    expect(result.reserved).toBe(1);
    expect(dispatched).toHaveLength(1);
    const staleLease = (await db.$client`select state, terminal_result from runner_leases where github_job_id=${staleJobId}`)[0];
    const queuedLease = (await db.$client`select state from runner_leases where github_job_id=${queuedJobId}`)[0];
    expect(staleLease.state).toBe("failed");
    expect(staleLease.terminal_result).toMatchObject({ reason: "startup_timeout" });
    expect(queuedLease.state).toBe("dispatched");
  } finally {
    await db.$client`delete from runner_leases where organization_id=${organizationId}`;
    await db.$client`delete from dashboard_jobs where organization_id=${organizationId}`;
    await db.$client`delete from dashboard_runs where organization_id=${organizationId}`;
    await db.$client`delete from runner_pools where id=${poolId}`;
    await db.$client`delete from workers where id=${workerId}`;
    await db.$client`delete from dashboard_repositories where id=${repositoryId}`;
    await db.$client`delete from dashboard_installations where id=${installationId}`;
    await db.$client`delete from organizations where id=${organizationId}`;
  }
});
