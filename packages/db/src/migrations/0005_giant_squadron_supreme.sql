ALTER TABLE "runner_leases" ADD COLUMN "cpu_mode" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_leases" ADD COLUMN "cpu_ids" jsonb;--> statement-breakpoint
ALTER TABLE "runner_pools" ADD COLUMN "cpu_mode" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_leases" ADD CONSTRAINT "runner_leases_cpu_mode_check" CHECK ("runner_leases"."cpu_mode" IN ('shared', 'exclusive'));--> statement-breakpoint
ALTER TABLE "runner_pools" ADD CONSTRAINT "runner_pools_cpu_mode_check" CHECK ("runner_pools"."cpu_mode" IN ('shared', 'exclusive'));