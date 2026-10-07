ALTER TABLE "llm_providers" ADD COLUMN "input_usd_per_million_tokens" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "llm_providers" ADD COLUMN "output_usd_per_million_tokens" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD COLUMN "input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD COLUMN "output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD COLUMN "input_usd_per_million_tokens" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD COLUMN "output_usd_per_million_tokens" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD COLUMN "provider_called_at" timestamp with time zone;