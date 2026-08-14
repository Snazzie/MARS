import { expect, test } from "bun:test";
import { schemaSql } from "./schema.ts";

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
