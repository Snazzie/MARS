CREATE TABLE IF NOT EXISTS worker_cache_status (
  worker_id uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  ready boolean NOT NULL DEFAULT false,
  ttl_seconds integer NOT NULL,
  proxy_origin text NOT NULL,
  cache_base_url text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  entry_count bigint NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  observed_at timestamptz NOT NULL,
  error text,
  active_snapshot_id uuid,
  active_snapshot_started_at timestamptz,
  last_completed_snapshot_id uuid
);

CREATE TABLE IF NOT EXISTS worker_cache_entries (
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  github_repository_id bigint NOT NULL,
  cache_key_preview text NOT NULL,
  cache_key_hash text NOT NULL,
  scope_preview text NOT NULL,
  scope_hash text NOT NULL,
  version_hash text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL,
  last_accessed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  observed_generation uuid NOT NULL,
  PRIMARY KEY (worker_id, entry_id)
);
CREATE INDEX IF NOT EXISTS worker_cache_entries_order_idx ON worker_cache_entries(worker_id, last_accessed_at DESC, entry_id);
CREATE INDEX IF NOT EXISTS worker_cache_entries_repository_idx ON worker_cache_entries(worker_id, github_repository_id);

CREATE TABLE IF NOT EXISTS worker_cache_snapshot_entries (
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  entry_id uuid NOT NULL,
  github_repository_id bigint NOT NULL,
  cache_key_preview text NOT NULL,
  cache_key_hash text NOT NULL,
  scope_preview text NOT NULL,
  scope_hash text NOT NULL,
  version_hash text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL,
  last_accessed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  observed_generation uuid NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, snapshot_id, sequence, entry_id)
);
CREATE INDEX IF NOT EXISTS worker_cache_snapshot_entries_idx ON worker_cache_snapshot_entries(worker_id, snapshot_id, sequence, entry_id);
ALTER TABLE worker_cache_status ADD COLUMN IF NOT EXISTS active_snapshot_id uuid;
ALTER TABLE worker_cache_status ADD COLUMN IF NOT EXISTS active_snapshot_started_at timestamptz;
ALTER TABLE worker_cache_status ADD COLUMN IF NOT EXISTS last_completed_snapshot_id uuid;
ALTER TABLE worker_cache_snapshot_entries ADD COLUMN IF NOT EXISTS staged_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS worker_cache_snapshot_entries_staged_at_idx ON worker_cache_snapshot_entries(staged_at);
