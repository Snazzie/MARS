ALTER TABLE "worker_cache_snapshot_entries" ADD COLUMN IF NOT EXISTS "staged_at" timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS "worker_cache_snapshot_entries_staged_at_idx" ON "worker_cache_snapshot_entries"("staged_at");
