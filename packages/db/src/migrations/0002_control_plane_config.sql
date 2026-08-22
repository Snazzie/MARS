CREATE TABLE IF NOT EXISTS "control_plane_config" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "public_base_url" text,
  "setup_code_hash" bytea,
  "setup_completed_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "control_plane_config_singleton_check" CHECK (singleton)
);
