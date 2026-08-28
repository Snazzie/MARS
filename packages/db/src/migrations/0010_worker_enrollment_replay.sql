ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "enrollment_code_hash" bytea;
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "enrollment_authenticated_at" timestamptz;
