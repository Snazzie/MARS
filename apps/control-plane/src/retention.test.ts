import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { pruneExpiredData } from "./retention.ts";

test("reports deleted-row counts for each configured retention scope", async () => {
  const priorRoot = Bun.env.MARS_DIAGNOSTICS_ROOT;
  const diagnosticsRoot = await mkdtemp(join(tmpdir(), "mars-retention-test-"));
  Bun.env.MARS_DIAGNOSTICS_ROOT = diagnosticsRoot;
  try {
    const requested: Record<string, unknown> = {};
    const counts: Record<string, number> = {
      retention_sessions: 2,
      retention_webhooks_completed: 3,
      retention_webhooks_failed: 4,
      retention_mutations: 5,
      retention_invalidations: 6,
      retention_logs: 7,
      retention_job_timings: 8,
      retention_job_resource_samples: 9,
      retention_audit: 10,
    };
    const db = preparedTestDatabase((name, parameters) => {
      requested[name] = parameters.days;
      return Array.from({ length: counts[name] ?? 0 }, () => ({}));
    });
    const result = await pruneExpiredData(db, {
      sessions: 1,
      webhooksCompleted: 2,
      webhooksFailed: 3,
      mutations: 4,
      invalidations: 5,
      logs: 6,
      audit: 7,
      jobTimings: 8,
      jobResourceSamples: 9,
      diagnostics: 3,
    });
    expect(result).toMatchObject({
      sessions: 2,
      webhooks_completed: 3,
      webhooks_failed: 4,
      mutations: 5,
      invalidations: 6,
      logs: 7,
      job_timings: 8,
      job_resource_samples: 9,
      audit: 10,
    });
    expect(requested).toEqual({
      retention_sessions: 1,
      retention_webhooks_completed: 2,
      retention_webhooks_failed: 3,
      retention_mutations: 4,
      retention_invalidations: 5,
      retention_logs: 6,
      retention_job_timings: 8,
      retention_job_resource_samples: 9,
      retention_audit: 7,
    });
  } finally {
    if (priorRoot === undefined) delete Bun.env.MARS_DIAGNOSTICS_ROOT;
    else Bun.env.MARS_DIAGNOSTICS_ROOT = priorRoot;
    await rm(diagnosticsRoot, { recursive: true, force: true });
  }
});
