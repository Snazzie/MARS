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
        expect(aggregate).toMatchObject({ queueP50Ms: 3_600_000, queueP95Ms: 3_600_000, durationP50Ms: 0, durationP95Ms: 0 });
        expect(organization).toMatchObject({ queueP50Ms: 3_600_000, queueP95Ms: 3_600_000, durationP50Ms: 0, durationP95Ms: 0 });
      }
      const nonmember = await getAllOverview(tx, "20000000-0000-4000-8000-000000000002", "24h");
      expect(nonmember.timeseries?.every(point => point.pending === 0 && point.running === 0)).toBe(true);
      expect(nonmember.jobOutcomes?.every(outcome => Object.values(outcome.platforms).every(count => count === 0))).toBe(true);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});

integration("overview percentiles use valid observed timings within the reporting period and membership scope", async () => {
  const db = createDb(databaseUrl!);
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
  const userId = "20000000-0000-4000-8000-000000000001";
  const metrics = (overview: Awaited<ReturnType<typeof getOverview>>) => ({
    queueP50Ms: overview.queueP50Ms, queueP95Ms: overview.queueP95Ms,
    durationP50Ms: overview.durationP50Ms, durationP95Ms: overview.durationP95Ms,
  });
  try {
    await db.transaction(async tx => {
      for (const table of ["dashboard_jobs", "dashboard_runs", "dashboard_repositories", "dashboard_installations", "memberships", "runner_leases", "runner_pools", "workers", "dashboard_job_resource_samples", "dashboard_job_timing_snapshots"]) {
        await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
      }
      await tx.$client.unsafe("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member')", [organizationId, userId]);
      await tx.$client.unsafe(`
        INSERT INTO dashboard_jobs (organization_id, run_id, github_job_id, name, status, stage, requested, queued_at, started_at, completed_at) VALUES
          ($1, gen_random_uuid(), 1, 'fast', 'completed', 'completed', '{}', now() - interval '2 hours 10 seconds', now() - interval '2 hours', now() - interval '1 hour 59 minutes'),
          ($1, gen_random_uuid(), 2, 'slow failed', 'completed', 'completed', '{}', now() - interval '3 hours 30 seconds', now() - interval '3 hours', now() - interval '2 hours 57 minutes'),
          ($1, gen_random_uuid(), 3, 'queued', 'queued', 'queued', '{}', now() - interval '1 hour', NULL, NULL),
          ($1, gen_random_uuid(), 4, 'missing start', 'completed', 'completed', '{}', now() - interval '1 hour', NULL, now()),
          ($1, gen_random_uuid(), 5, 'invalid chronology', 'completed', 'completed', '{}', now(), now() - interval '1 second', now() - interval '2 seconds'),
          ($1, gen_random_uuid(), 6, 'previous week', 'completed', 'completed', '{}', now() - interval '2 days 50 seconds', now() - interval '2 days', now() - interval '2 days' + interval '5 minutes'),
          ($1, gen_random_uuid(), 7, 'previous month', 'completed', 'completed', '{}', now() - interval '10 days 70 seconds', now() - interval '10 days', now() - interval '10 days' + interval '7 minutes'),
          ($1, gen_random_uuid(), 8, 'expired', 'completed', 'completed', '{}', now() - interval '40 days 1 hour', now() - interval '40 days', now() - interval '39 days'),
          ($2, gen_random_uuid(), 9, 'nonmember', 'completed', 'completed', '{}', now() - interval '10 hours', now() - interval '5 hours', now());
      `, [organizationId, otherOrganizationId]);
      await tx.$client.unsafe("UPDATE dashboard_jobs SET conclusion = CASE WHEN github_job_id = 2 THEN 'failure' ELSE 'success' END WHERE status = 'completed'");
      const expected = {
        "24h": { queueP50Ms: 20_000, queueP95Ms: 29_000, durationP50Ms: 120_000, durationP95Ms: 174_000 },
        "7d": { queueP50Ms: 30_000, queueP95Ms: 48_000, durationP50Ms: 180_000, durationP95Ms: 288_000 },
        "30d": { queueP50Ms: 40_000, queueP95Ms: 67_000, durationP50Ms: 240_000, durationP95Ms: 402_000 },
      };
      for (const period of ["24h", "7d", "30d"] as const) {
        expect(metrics(await getOverview(tx, organizationId, period))).toEqual(expected[period]);
        expect(metrics(await getAllOverview(tx, userId, period))).toEqual(expected[period]);
      }
      const empty = { queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0 };
      expect(metrics(await getOverview(tx, "10000000-0000-4000-8000-000000000003", "24h"))).toEqual(empty);
      expect(metrics(await getAllOverview(tx, "20000000-0000-4000-8000-000000000002", "24h"))).toEqual(empty);
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
});
