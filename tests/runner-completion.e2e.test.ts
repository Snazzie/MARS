import { afterAll, expect, test } from "bun:test";
import { createDb, type DatabaseClient } from "../packages/db/src/index.ts";
import { applyWorkerLeaseEvent } from "../apps/control-plane/src/worker-lifecycle.ts";
import { applyWorkflowJobWebhook, configureRunLifecycle } from "../apps/control-plane/src/runs.ts";
import { runQueuedJobReconciliation } from "../apps/control-plane/src/job-reconciler.ts";

const url = Bun.env.MARS_E2E_DATABASE_URL;
const db = url ? createDb(url) : undefined;
afterAll(async () => { await db?.end({ timeout: 1 }); });

for (const exitCode of [0, 125]) {
  for (const completedBeforeExit of [false, true]) {
    test.skipIf(!db)(`runner exit ${exitCode} preserves GitHub state (completion before exit: ${completedBeforeExit})`, async () => {
      const rollback = new Error("rollback fixture");
      try {
        await db!.begin(async transaction => {
          const tx = transaction as unknown as DatabaseClient;
          const organizationId = crypto.randomUUID(), installationId = crypto.randomUUID(), repositoryId = crypto.randomUUID();
          const workerId = crypto.randomUUID(), poolId = crypto.randomUUID(), leaseId = crypto.randomUUID();
          const githubId = Math.floor(Math.random() * 1_000_000_000), nonce = "n".repeat(32);
          const fullName = `runner-regression/${repositoryId}`;
          await tx`INSERT INTO organizations (id,github_org_id,login) VALUES (${organizationId},${githubId},${organizationId})`;
          await tx`INSERT INTO dashboard_installations (id,organization_id,github_installation_id,state,repository_selection) VALUES (${installationId},${organizationId},${githubId},'approved','selected')`;
          await tx`INSERT INTO dashboard_repositories (id,organization_id,installation_id,github_repository_id,name,full_name,visibility,available) VALUES (${repositoryId},${organizationId},${installationId},${githubId},'repo',${fullName},'private',true)`;
          await tx`INSERT INTO workers (id,name,platform,admission_state,connection_state,configuration_state,limits) VALUES (${workerId},'runner-regression','linux-x64','adopted','offline','ready','{}'::jsonb)`;
          await tx`INSERT INTO runner_pools (id,organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) VALUES (${poolId},${organizationId},${workerId},'runner-regression','linux-x64','linux-libvirt-vm','sha256:test','{}'::jsonb,'[]'::jsonb,'mars-linux-x64',false)`;
          configureRunLifecycle(tx);
          const webhook = (status: string) => applyWorkflowJobWebhook({ action: status, installation: { id: githubId }, repository: { id: githubId, name: 'repo', full_name: fullName }, workflow_job: { id: githubId, run_id: githubId, run_attempt: 1, name: 'build', status, conclusion: status === 'completed' ? 'success' : null, created_at: '2026-10-01T00:00:00Z', completed_at: status === 'completed' ? '2026-10-01T00:01:00Z' : null, labels: ['mars-linux-x64-1vcpu-1g'] } });
          expect(await webhook('queued')).toBe(true);
          await tx`INSERT INTO runner_leases (id,organization_id,pool_id,worker_id,routing_key,github_job_id,state,requested,nonce,expires_at) VALUES (${leaseId},${organizationId},${poolId},${workerId},'runner-regression',${githubId},'dispatched','{}'::jsonb,${nonce},now()+interval '10 minutes')`;
          const event = (type: string, payload: Record<string, unknown>) => ({ version: 1, id: crypto.randomUUID(), workerId, type, occurredAt: '2026-10-01T00:02:00Z', payload: { leaseId, nonce, ...payload } });
          expect(await applyWorkerLeaseEvent(tx, event('sandbox_attested', { runtimeInstanceId: 'regression', observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }))).toBe(true);
          const state = async () => (await tx`SELECT status,conclusion,stage,started_at,completed_at FROM dashboard_jobs WHERE organization_id=${organizationId} AND github_job_id=${githubId}`)[0];
          expect(await state()).toMatchObject({ status: 'queued', conclusion: null, stage: 'queued', started_at: null, completed_at: null });
          if (completedBeforeExit) expect(await webhook('completed')).toBe(true);
          const beforeExit = await state();
          expect(await applyWorkerLeaseEvent(tx, event('runner.finished', { exitCode }))).toBe(true);
          expect(await state()).toEqual(beforeExit);
          expect(await applyWorkerLeaseEvent(tx, event('runner.finished', { exitCode }))).toBe(false);
          const [lease] = await tx`SELECT state,cleanup_state,terminal_result FROM runner_leases WHERE id=${leaseId}`;
          expect(lease).toMatchObject({ state: exitCode === 0 ? 'completed' : 'failed', cleanup_state: 'pending', terminal_result: { exitCode } });
          expect(await applyWorkerLeaseEvent(tx, event('lease.reaped', {}))).toBe(true);
          let queueSize = -1;
          await runQueuedJobReconciliation({ db: tx, repositoryFullName: fullName, contractVersion: '1', installationToken: async () => { throw new Error('no GitHub request expected'); }, githubFetchForInstallation: () => async () => { throw new Error('no GitHub request expected'); }, dispatcher: { dispatch: async () => { throw new Error('no worker dispatch expected'); } }, onQueueSize: value => { queueSize = value; } });
          expect(queueSize).toBe(completedBeforeExit ? 0 : 1);
          if (!completedBeforeExit) expect(await webhook('completed')).toBe(true);
          expect(await state()).toMatchObject({ status: 'completed', conclusion: 'success', stage: 'completed' });
          await tx`UPDATE dashboard_jobs SET stage='running' WHERE organization_id=${organizationId} AND github_job_id=${githubId}`;
          expect(await webhook('completed')).toBe(true);
          expect(await state()).toMatchObject({ status: 'completed', conclusion: 'success', stage: 'completed' });
          expect(await webhook('queued')).toBe(true);
          expect(await state()).toMatchObject({ status: 'completed', conclusion: 'success', stage: 'completed' });
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      } finally {
        configureRunLifecycle(db!);
      }
    });
  }
}
