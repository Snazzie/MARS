import { expect, test } from "bun:test";
import { createDb, getAllOverview, getOverview } from "./index.ts";

const databaseUrl = Bun.env.MARS_E2E_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration("aggregate overview binds nullable organization scope and excludes nonmember jobs", async () => {
  const db = createDb(databaseUrl!);
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
  const userId = "20000000-0000-4000-8000-000000000001";
  try {
    await db.transaction(async tx => {
      // Copy column types, not application data or foreign keys, into connection-local tables.
      for (const table of ["dashboard_jobs", "dashboard_runs", "dashboard_repositories", "dashboard_installations", "memberships", "runner_leases", "runner_pools", "workers", "dashboard_job_resource_samples", "dashboard_job_timing_snapshots"]) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
      }
      await tx.$client.unsafe("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member')", [organizationId, userId]);
      await tx.$client.unsafe(`
        INSERT INTO dashboard_jobs (organization_id, run_id, github_job_id, name, status, stage, requested, requested_labels, queued_at, started_at) VALUES
          ($1, gen_random_uuid(), 1, 'member running', 'in_progress', 'running', '{}', '["windows-latest"]', now() - interval '3 hours', now() - interval '2 hours'),
          ($1, gen_random_uuid(), 2, 'member queued', 'queued', 'queued', '{}', '["ubuntu-latest"]', now() - interval '3 hours', NULL),
          ($2, gen_random_uuid(), 3, 'nonmember running', 'in_progress', 'running', '{}', '["windows-latest"]', now() - interval '3 hours', now() - interval '2 hours'),
          ($2, gen_random_uuid(), 4, 'nonmember queued', 'queued', 'queued', '{}', '["ubuntu-latest"]', now() - interval '3 hours', NULL);
      `, [organizationId, otherOrganizationId]);

      for (const period of ["24h", "7d", "30d"] as const) {
        const aggregate = await getAllOverview(tx, userId, period);
        const organization = await getOverview(tx, organizationId, period);
        expect(aggregate.organizationId).toBe("all");
        expect(aggregate.timeseries).toEqual(organization.timeseries);
        expect(aggregate.timeseries?.at(-1)).toMatchObject({ pending: 1, running: 1 });
        expect(aggregate.jobOutcomes).toEqual(organization.jobOutcomes);
        expect(aggregate.jobOutcomes).toContainEqual({ outcome: "running", platforms: { macos: 0, ubuntu: 0, windows: 1, other: 0 } });
        expect(aggregate.jobOutcomes).toContainEqual({ outcome: "queued", platforms: { macos: 0, ubuntu: 1, windows: 0, other: 0 } });
      }
      const nonmember = await getAllOverview(tx, "20000000-0000-4000-8000-000000000002", "24h");
      expect(nonmember.timeseries?.every(point => point.pending === 0 && point.running === 0)).toBe(true);
      expect(nonmember.jobOutcomes?.every(outcome => Object.values(outcome.platforms).every(count => count === 0))).toBe(true);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});
