import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createDb, migrateDatabase, type DatabaseClient } from "../packages/db/src/index.ts";
import { applyWorkflowJobWebhook, configureRunLifecycle } from "../apps/control-plane/src/runs.ts";
import { runQueuedJobReconciliation } from "../apps/control-plane/src/job-reconciler.ts";

const databaseUrl = Bun.env.WHITESMITH_E2E_DATABASE_URL;
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
  await db`insert into runner_pools (id, organization_id, worker_id, name, platform, driver, image_digest, resources, labels, trigger_label, enabled) values (${poolId}, ${org.id}, ${workerId}, 'e2e', 'linux-x64', 'kata-k3s', 'ubuntu@sha256:' || repeat('a', 64), ${JSON.stringify({ vcpu: 1, memoryBytes: 1024, storageBytes: 2048, concurrency: 1 })}, ${JSON.stringify(['self-hosted', 'linux', 'x64', 'whitesmith-e2e'])}, 'whitesmith-e2e', true)`;

  const accepted = await applyWorkflowJobWebhook({ action: 'queued', installation: { id: (await db`select github_installation_id from dashboard_installations where id=${installationId}`)[0].github_installation_id }, repository: { id: (await db`select github_repository_id from dashboard_repositories where id=${repositoryId}`)[0].github_repository_id, name: 'repo', full_name: 'e2e-org/repo' }, workflow_job: { id: 987654321, run_id: 123456789, run_number: 1, name: 'build', status: 'queued', labels: ['self-hosted', 'linux', 'x64', 'whitesmith-e2e'] } });
  expect(accepted).toBe(true);

  const dispatched: unknown[] = [];
  const result = await runQueuedJobReconciliation({
    db,
    installationToken: async () => "installation-token",
    githubFetchForInstallation: () => async (_input, init) => { expect(init?.method).toBe("POST"); return Response.json({ encoded_jit_config: "encoded-jit-config" }); },
    dispatcher: { dispatch: async (command) => { dispatched.push(command); return {} as never; } },
  });
  expect(result).toEqual({ reserved: 1, skipped: 0, failed: 0 });
  expect(dispatched).toHaveLength(1);
  const [lease] = await db`select state, github_job_id, expires_at from runner_leases where github_job_id=987654321`;
  expect(lease.state).toBe('dispatched');
  expect(new Date(lease.expires_at).getTime() - Date.now()).toBeGreaterThan(5 * 60_000);
});
