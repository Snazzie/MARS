import { expect, test } from "bun:test";
import { createDb, getGithubRunnerCostCenter, getGithubRunnerCostSavings } from "./index.ts";

const databaseUrl = Bun.env.MARS_E2E_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration("cost estimates charge only job runtime, not queue or runner-ready waiting", async () => {
  const db = createDb(databaseUrl!);
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const repositoryId = "20000000-0000-4000-8000-000000000001";
  const runId = "30000000-0000-4000-8000-000000000001";
  try {
    await db.transaction(async tx => {
      // Connection-local tables isolate these fixtures from application data.
      await tx.$client.unsafe(`
        CREATE TEMP TABLE dashboard_job_timing_snapshots (
          organization_id uuid, job_id uuid, repository_id uuid, repository_name text,
          platform text, requested_vcpu bigint, completed_at timestamptz,
          started_at timestamptz, execution_duration_ms bigint
        ) ON COMMIT DROP;
        CREATE TEMP TABLE memberships (organization_id uuid, user_id uuid) ON COMMIT DROP;
        CREATE TEMP TABLE dashboard_jobs (
          id uuid, organization_id uuid, run_id uuid, status text, requested_labels jsonb,
          started_at timestamptz, completed_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE dashboard_runs (id uuid, organization_id uuid, repository_id uuid) ON COMMIT DROP;
        CREATE TEMP TABLE dashboard_repositories (id uuid, organization_id uuid, full_name text) ON COMMIT DROP;
      `);
      await tx.$client.unsafe(`
        INSERT INTO dashboard_job_timing_snapshots VALUES
          ($1, '40000000-0000-4000-8000-000000000001', $2, 'acme/app', 'windows-x64', 2, now(), now() - interval '61 seconds', 3600000),
          ($1, '40000000-0000-4000-8000-000000000002', $2, 'acme/app', 'windows-x64', 2, now(), now() - interval '1 second', 600000),
          ($1, '40000000-0000-4000-8000-000000000003', $2, 'acme/app', 'windows-x64', 2, now(), NULL, 300000);
      `, [organizationId, repositoryId]);
      await tx.$client.unsafe("INSERT INTO dashboard_runs VALUES ($1, $2, $3)", [runId, organizationId, repositoryId]);
      await tx.$client.unsafe("INSERT INTO dashboard_repositories VALUES ($1, $2, 'acme/app')", [repositoryId, organizationId]);
      await tx.$client.unsafe(`
        INSERT INTO dashboard_jobs VALUES
          ('50000000-0000-4000-8000-000000000001', $1, $2, 'completed', '["windows-latest"]', now() - interval '61 seconds', now()),
          ('50000000-0000-4000-8000-000000000002', $1, $2, 'completed', '["windows-latest"]', NULL, now());
      `, [organizationId, runId]);

      const savings = await getGithubRunnerCostSavings(tx, organizationId, "24h");
      expect(savings).toMatchObject({ selfHostedMinutes: 3, pricedMinutes: 3, estimatedSavingsMicros: 30_000 });
      const center = await getGithubRunnerCostCenter(tx, organizationId, "24h");
      expect(center.costSavings).toEqual(savings);
      expect(center.breakdown).toEqual([expect.objectContaining({ jobCount: 2, selfHostedMinutes: 3, estimatedSavingsMicros: 30_000 })]);
      expect(center.externalMinutes).toBe(2);
      expect(center.externalBreakdown).toEqual([expect.objectContaining({ jobCount: 1, billableMinutes: 2 })]);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});
