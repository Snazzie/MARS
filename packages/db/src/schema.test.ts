import { expect, test } from "bun:test";
import { baselineSchemaSql, jobTimingMigrationSql, jsonShapeNormalizationMigrationSql, onboardingVerificationMigrationSql, schemaSql, workerConfigurationMigrationSql, workerJsonNormalizationMigrationSql } from "./schema.ts";
import { workers } from "./drizzle-schema.ts";
test("workers retain crash-safe enrollment replay evidence columns", () => {
  expect(workers.enrollmentCodeHash).toBeDefined();
  expect(workers.enrollmentAuthenticatedAt).toBeDefined();
});
test("webhook deliveries default to pending state for retention cleanup", () => {
  expect(schemaSql).toContain(
    "CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id text PRIMARY KEY, installation_id bigint NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), state text NOT NULL DEFAULT 'pending');",
  );
});


test("repository authorization is represented only by GitHub availability", () => {
  const repositoryDefinition = schemaSql.match(/CREATE TABLE IF NOT EXISTS dashboard_repositories \(([^;]+)\);/)?.[1];
  expect(repositoryDefinition).toBeDefined();
  expect(repositoryDefinition).not.toContain("approved");
  expect(schemaSql).toContain("ALTER TABLE dashboard_repositories DROP COLUMN IF EXISTS approved;");
});

test("drops the legacy approval column after legacy repository normalization", () => {
  const normalization = schemaSql.indexOf("UPDATE dashboard_repositories SET visibility=");
  const drop = schemaSql.indexOf("ALTER TABLE dashboard_repositories DROP COLUMN IF EXISTS approved;");
  expect(normalization).toBeGreaterThan(-1);
  expect(drop).toBeGreaterThan(normalization);
});

test("repository discovery cooldown is durable and nullable for existing rows", () => {
  expect(schemaSql).toContain("ALTER TABLE dashboard_repositories ADD COLUMN IF NOT EXISTS discovery_error text;");
  expect(schemaSql).toContain("ALTER TABLE dashboard_repositories ADD COLUMN IF NOT EXISTS discovery_retry_at timestamptz;");
  expect(schemaSql).not.toContain("discovery_retry_at timestamptz NOT NULL");
});

test("migrates legacy split runner labels to one composite trigger", () => {
  expect(schemaSql).toContain("WHEN platform='windows-x64' AND trigger_label='mars-default' THEN 'mars-windows-x64'");
  expect(schemaSql).toContain("WHEN platform='linux-x64' AND trigger_label='mars-default' THEN 'mars-linux-x64'");
  expect(schemaSql).toContain("WHEN platform='macos-arm64' AND trigger_label IN ('mars-default','mars-macos') THEN 'mars-macos-arm64'");
  expect(schemaSql).toContain("UPDATE runner_pools SET labels=jsonb_build_array(trigger_label)");
});

test("persists desired and exactly applied worker configuration", () => {
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS desired_configuration jsonb;");
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS applied_configuration_revision text;");
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS configuration_applied_at timestamptz;");
  expect(schemaSql).toContain("FROM commands c");
  expect(schemaSql).toContain("c.id=w.configuration_command_id");
});

test("keeps worker configuration and timing changes in append-only migrations", () => {
  expect(baselineSchemaSql).not.toContain("desired_configuration");
  expect(workerConfigurationMigrationSql).toContain("ADD COLUMN IF NOT EXISTS desired_configuration");
  expect(jobTimingMigrationSql).toContain("CREATE TABLE IF NOT EXISTS dashboard_job_timing_snapshots");
  expect(schemaSql).toContain(jobTimingMigrationSql);
});

test("timing snapshots preserve dimensions and non-negative durations", () => {
  expect(schemaSql).toContain("PRIMARY KEY (organization_id, job_id)");
  expect(schemaSql).toContain("queue_duration_ms bigint NOT NULL CHECK(queue_duration_ms >= 0)");
  expect(schemaSql).toContain("execution_duration_ms bigint NOT NULL CHECK(execution_duration_ms >= 0)");
  expect(schemaSql).toContain("requested_vcpu bigint NOT NULL CHECK(requested_vcpu > 0)");
  expect(schemaSql).toContain("effective_concurrency bigint NOT NULL CHECK(effective_concurrency > 0)");
});

test("creates the dashboard job composite key before dependent foreign keys", () => {
  const key = schemaSql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS dashboard_jobs_org_run_id_idx");
  const timingForeignKey = schemaSql.indexOf("FOREIGN KEY (organization_id, run_id, job_id) REFERENCES dashboard_jobs");
  expect(key).toBeGreaterThan(-1);
  expect(timingForeignKey).toBeGreaterThan(key);
});

test("normalizes legacy double-encoded worker JSON in a later migration", () => {
  expect(baselineSchemaSql).not.toContain("#>> '{}'");
  expect(workerJsonNormalizationMigrationSql).toContain("jsonb_typeof(guest_platforms)='string'");
  expect(workerJsonNormalizationMigrationSql).toContain("jsonb_typeof(desired_configuration)='string'");
});

test("normalizes every persisted JSONB shape after legacy string writes", () => {
  expect(jsonShapeNormalizationMigrationSql).toContain("UPDATE runner_pools SET resources=");
  expect(jsonShapeNormalizationMigrationSql).toContain("UPDATE runner_leases SET requested=");
  expect(jsonShapeNormalizationMigrationSql).toContain("UPDATE dashboard_jobs SET requested_labels=");
  expect(jsonShapeNormalizationMigrationSql).toContain("UPDATE webhook_deliveries SET payload=");
  expect(jsonShapeNormalizationMigrationSql).toContain("UPDATE workers SET doctor=");
});

test("adds onboarding verification state in an append-only migration", () => {
  expect(baselineSchemaSql).not.toContain("verification_github_run_id");
  expect(onboardingVerificationMigrationSql).toContain("verification_repository_id");
  expect(onboardingVerificationMigrationSql).toContain("verification_pool_id");
  expect(onboardingVerificationMigrationSql).toContain("verification_github_run_id");
});
