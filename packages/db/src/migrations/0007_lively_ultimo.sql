CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"encrypted_api_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_kind_check" CHECK (kind = ANY (ARRAY['openai-compatible'::text, 'anthropic'::text]))
);
--> statement-breakpoint
CREATE TABLE "pipeline_analysis_comments" (
	"analysis_id" uuid NOT NULL,
	"pr_number" bigint NOT NULL,
	"state" text NOT NULL,
	"comment_id" bigint,
	"comment_url" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_analysis_comments_pkey" PRIMARY KEY("analysis_id","pr_number"),
	CONSTRAINT "pipeline_analysis_comments_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'unknown'::text]))
);
--> statement-breakpoint
CREATE TABLE "pipeline_failure_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"github_run_id" bigint NOT NULL,
	"run_attempt" integer NOT NULL,
	"provider_id" uuid,
	"provider_kind" text NOT NULL,
	"provider_name" text NOT NULL,
	"model" text NOT NULL,
	"source" jsonb NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_failure_analyses_attempt_key" UNIQUE("organization_id","repository_id","github_run_id","run_attempt"),
	CONSTRAINT "pipeline_failure_analyses_attempt_check" CHECK (run_attempt > 0),
	CONSTRAINT "pipeline_failure_analyses_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'skipped'::text]))
);
--> statement-breakpoint
CREATE TABLE "repository_failure_analysis_settings" (
	"organization_id" uuid NOT NULL,
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_failure_analysis_settings_enabled_provider_check" CHECK (NOT enabled OR provider_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "pipeline_analysis_comments" ADD CONSTRAINT "pipeline_analysis_comments_analysis_fkey" FOREIGN KEY ("analysis_id") REFERENCES "public"."pipeline_failure_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD CONSTRAINT "pipeline_failure_analyses_run_fkey" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."dashboard_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD CONSTRAINT "pipeline_failure_analyses_repository_fkey" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."dashboard_repositories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_failure_analyses" ADD CONSTRAINT "pipeline_failure_analyses_provider_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_failure_analysis_settings" ADD CONSTRAINT "repository_failure_analysis_settings_repository_fkey" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."dashboard_repositories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_failure_analysis_settings" ADD CONSTRAINT "repository_failure_analysis_settings_provider_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE restrict ON UPDATE no action;