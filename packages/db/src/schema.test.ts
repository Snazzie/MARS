import { expect, test } from "bun:test";
import { baselineSchemaSql, jsonShapeNormalizationMigrationSql, schemaSql, workerConfigurationMigrationSql, workerJsonNormalizationMigrationSql } from "./schema.ts";

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
  expect(schemaSql).toContain("WHEN platform='windows-x64' AND trigger_label='whitesmith-default' THEN 'whitesmith-windows-x64'");
  expect(schemaSql).toContain("WHEN platform='linux-x64' AND trigger_label='whitesmith-default' THEN 'whitesmith-linux-x64'");
  expect(schemaSql).toContain("WHEN platform='macos-arm64' AND trigger_label IN ('whitesmith-default','whitesmith-macos') THEN 'whitesmith-macos-arm64'");
  expect(schemaSql).toContain("UPDATE runner_pools SET labels=jsonb_build_array(trigger_label)");
});

test("persists desired and exactly applied worker configuration", () => {
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS desired_configuration jsonb;");
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS applied_configuration_revision text;");
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS configuration_applied_at timestamptz;");
  expect(schemaSql).toContain("FROM commands c");
  expect(schemaSql).toContain("c.id=w.configuration_command_id");
});

test("keeps worker configuration changes out of the immutable baseline migration", () => {
  expect(baselineSchemaSql).not.toContain("desired_configuration");
  expect(workerConfigurationMigrationSql).toContain("ADD COLUMN IF NOT EXISTS desired_configuration");
  expect(schemaSql).toBe(`${baselineSchemaSql}\n${workerConfigurationMigrationSql}\n${workerJsonNormalizationMigrationSql}\n${jsonShapeNormalizationMigrationSql}`);
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
