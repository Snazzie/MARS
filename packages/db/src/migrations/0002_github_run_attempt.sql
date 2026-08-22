ALTER TABLE "github_discovery_checkpoints" ADD COLUMN "completed_run_attempt" integer NOT NULL DEFAULT 1;
ALTER TABLE "github_discovery_checkpoints" ADD CONSTRAINT "github_discovery_checkpoints_completed_run_attempt_check" CHECK ("completed_run_attempt" > 0);
ALTER TABLE "dashboard_runs" ADD COLUMN "run_attempt" integer NOT NULL DEFAULT 1;
ALTER TABLE "dashboard_runs" ADD CONSTRAINT "dashboard_runs_run_attempt_check" CHECK ("run_attempt" > 0);
ALTER TABLE "dashboard_jobs" ADD COLUMN "run_attempt" integer NOT NULL DEFAULT 1;
ALTER TABLE "dashboard_jobs" ADD CONSTRAINT "dashboard_jobs_run_attempt_check" CHECK ("run_attempt" > 0);
