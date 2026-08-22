CREATE TABLE IF NOT EXISTS "control_plane_config" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "public_base_url" text,
  "setup_code_hash" bytea,
  "setup_completed_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "control_plane_config_singleton_check" CHECK (singleton)
);

ALTER TABLE "github_discovery_checkpoints" ADD COLUMN IF NOT EXISTS "completed_run_attempt" integer NOT NULL DEFAULT 1;
ALTER TABLE "dashboard_runs" ADD COLUMN IF NOT EXISTS "run_attempt" integer NOT NULL DEFAULT 1;
ALTER TABLE "dashboard_jobs" ADD COLUMN IF NOT EXISTS "run_attempt" integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'github_discovery_checkpoints'::regclass
      AND conname = 'github_discovery_checkpoints_completed_run_attempt_check'
  ) THEN
    ALTER TABLE "github_discovery_checkpoints"
      ADD CONSTRAINT "github_discovery_checkpoints_completed_run_attempt_check"
      CHECK ("completed_run_attempt" > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dashboard_runs'::regclass
      AND conname = 'dashboard_runs_run_attempt_check'
  ) THEN
    ALTER TABLE "dashboard_runs"
      ADD CONSTRAINT "dashboard_runs_run_attempt_check"
      CHECK ("run_attempt" > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dashboard_jobs'::regclass
      AND conname = 'dashboard_jobs_run_attempt_check'
  ) THEN
    ALTER TABLE "dashboard_jobs"
      ADD CONSTRAINT "dashboard_jobs_run_attempt_check"
      CHECK ("run_attempt" > 0);
  END IF;
END $$;
