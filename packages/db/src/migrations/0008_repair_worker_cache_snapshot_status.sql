ALTER TABLE "worker_cache_status" ADD COLUMN IF NOT EXISTS "active_snapshot_id" uuid;
ALTER TABLE "worker_cache_status" ADD COLUMN IF NOT EXISTS "active_snapshot_started_at" timestamptz;
ALTER TABLE "worker_cache_status" ADD COLUMN IF NOT EXISTS "last_completed_snapshot_id" uuid;
