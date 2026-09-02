import { expect, test } from "bun:test";
import { baselineSchemaSql, jobTimingMigrationSql, jsonShapeNormalizationMigrationSql, onboardingVerificationMigrationSql, schemaSql, workerConfigurationMigrationSql, workerJsonNormalizationMigrationSql } from "./schema.ts";
import { workers } from "./drizzle-schema.ts";
test("workers retain crash-safe enrollment replay evidence columns", () => {
  expect(workers.enrollmentCodeHash).toBeDefined();
  expect(workers.enrollmentAuthenticatedAt).toBeDefined();
});
test("webhook deliveries match the ORM-required baseline fields and index", () => {
  const webhookDefinition = "CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id text PRIMARY KEY, installation_id bigint NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), event_name text NOT NULL DEFAULT 'unknown', state text NOT NULL DEFAULT 'received', attempt_count integer NOT NULL DEFAULT 0, last_error text, processed_at timestamptz);";
  expect(schemaSql).toContain(webhookDefinition);
  expect(schemaSql).toContain("CREATE INDEX IF NOT EXISTS webhook_deliveries_state_idx ON webhook_deliveries(state, received_at);");
  expect(schemaSql).not.toContain("CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id text PRIMARY KEY, installation_id bigint NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), state text NOT NULL DEFAULT 'pending');");
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
test("canonical and baseline schemas define control-plane setup state", () => {
  for (const sql of [schemaSql, baselineSchemaSql]) {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS control_plane_config (");
    expect(sql).toContain("singleton boolean PRIMARY KEY DEFAULT true NOT NULL");
    expect(sql).toContain("public_base_url text");
    expect(sql).toContain("setup_code_hash bytea");
    expect(sql).toContain("setup_completed_at timestamptz");
    expect(sql).toContain("updated_at timestamptz NOT NULL DEFAULT now()");
    expect(sql).toContain("CONSTRAINT control_plane_config_singleton_check CHECK (singleton)");
  }
});

test("canonical and baseline schemas constrain GitHub run attempts", () => {
  for (const sql of [schemaSql, baselineSchemaSql]) {
    expect(sql).toContain(
      "ALTER TABLE github_discovery_checkpoints ADD COLUMN IF NOT EXISTS completed_run_attempt integer NOT NULL DEFAULT 1;",
    );
    expect(sql).toContain(
      "ALTER TABLE dashboard_runs ADD COLUMN IF NOT EXISTS run_attempt integer NOT NULL DEFAULT 1;",
    );
    expect(sql).toContain(
      "ALTER TABLE dashboard_jobs ADD COLUMN IF NOT EXISTS run_attempt integer NOT NULL DEFAULT 1;",
    );
    expect(sql).toContain("github_discovery_checkpoints_completed_run_attempt_check");
    expect(sql).toContain("dashboard_runs_run_attempt_check");
    expect(sql).toContain("dashboard_jobs_run_attempt_check");
    expect(sql).toContain("CHECK (completed_run_attempt > 0)");
    expect(sql).toContain("CHECK (run_attempt > 0)");
  }
});

test("canonical and baseline schemas define worker cache tables and indexes", () => {
  for (const sql of [schemaSql, baselineSchemaSql]) {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS worker_cache_status (");
    expect(sql).toContain("worker_id uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE");
    expect(sql).toContain("size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0)");
    expect(sql).toContain("entry_count bigint NOT NULL DEFAULT 0 CHECK (entry_count >= 0)");
    expect(sql).toContain("runner_cache_enabled boolean");
    expect(sql).toContain("runner_cache_max_gib bigint");
    expect(sql).toContain("runner_cache_size_bytes bigint");
    expect(sql).toContain("runner_cache_entry_count bigint");
    expect(sql).toContain("runner_cache_observed_at timestamptz");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS worker_cache_entries (");
    expect(sql).toContain("PRIMARY KEY (worker_id, entry_id)");
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS worker_cache_entries_order_idx ON worker_cache_entries(worker_id, last_accessed_at DESC, entry_id);",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS worker_cache_entries_repository_idx ON worker_cache_entries(worker_id, github_repository_id);",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS worker_cache_snapshot_entries (");
    expect(sql).toContain("sequence integer NOT NULL CHECK (sequence >= 0)");
    expect(sql).toContain(
      "PRIMARY KEY (worker_id, snapshot_id, sequence, entry_id)",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS worker_cache_snapshot_entries_idx ON worker_cache_snapshot_entries(worker_id, snapshot_id, sequence, entry_id);",
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS worker_cache_snapshot_entries_staged_at_idx ON worker_cache_snapshot_entries(staged_at);",
    );
  }
});

test("canonical and baseline schemas define enrollment replay columns", () => {
  for (const sql of [schemaSql, baselineSchemaSql]) {
    expect(sql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS enrollment_code_hash bytea;");
    expect(sql).toContain(
      "ALTER TABLE workers ADD COLUMN IF NOT EXISTS enrollment_authenticated_at timestamptz;",
    );
  }
});
