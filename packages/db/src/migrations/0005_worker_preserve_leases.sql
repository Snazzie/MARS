ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "preserve_leases" boolean NOT NULL DEFAULT false;
