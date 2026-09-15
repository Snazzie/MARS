ALTER TABLE dashboard_job_timing_snapshots ADD COLUMN IF NOT EXISTS worker_id uuid;
UPDATE dashboard_job_timing_snapshots s SET worker_id=l.worker_id
FROM runner_leases l
WHERE s.worker_id IS NULL AND s.organization_id=l.organization_id AND s.github_job_id=l.github_job_id;
ALTER TABLE dashboard_job_timing_snapshots ALTER COLUMN worker_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS dashboard_job_timing_worker_idx ON dashboard_job_timing_snapshots(organization_id, worker_id, completed_at DESC);
