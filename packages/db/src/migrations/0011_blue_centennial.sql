CREATE TABLE "pr_review_commands" (
	"repository_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"comment_id" bigint NOT NULL,
	"requester" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_commands_repository_comment_key" UNIQUE("repository_id","comment_id")
);
--> statement-breakpoint
CREATE TABLE "pr_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"trigger" text NOT NULL,
	"comment_id" bigint,
	"requester" text,
	"provider_id" uuid,
	"provider_snapshot" jsonb NOT NULL,
	"settings_updated_at" timestamp with time zone NOT NULL,
	"analysis_state" text DEFAULT 'pending' NOT NULL,
	"publication_state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"source" jsonb NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"estimated_cost_usd" numeric(14, 6),
	"error_code" text,
	"review_id" bigint,
	"review_url" text,
	"provider_called_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"publication_started_at" timestamp with time zone,
	CONSTRAINT "pr_reviews_revision_key" UNIQUE("organization_id","repository_id","pr_number","base_sha","head_sha"),
	CONSTRAINT "pr_reviews_pr_number_check" CHECK (pr_number > 0),
	CONSTRAINT "pr_reviews_trigger_check" CHECK (trigger = ANY (ARRAY['opened'::text, 'synchronize'::text, 'ready_for_review'::text, 'reopened'::text, 'review_command'::text])),
	CONSTRAINT "pr_reviews_analysis_state_check" CHECK (analysis_state = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'skipped'::text, 'superseded'::text])),
	CONSTRAINT "pr_reviews_publication_state_check" CHECK (publication_state = ANY (ARRAY['pending'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'unknown'::text]))
);
--> statement-breakpoint
CREATE TABLE "repository_pr_review_settings" (
	"organization_id" uuid NOT NULL,
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider_id" uuid,
	"enabled_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_pr_review_settings_enabled_provider_check" CHECK (NOT enabled OR provider_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "pr_review_commands" ADD CONSTRAINT "pr_review_commands_repository_fkey" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."dashboard_repositories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_repository_fkey" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."dashboard_repositories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_provider_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_pr_review_settings" ADD CONSTRAINT "repository_pr_review_settings_repository_fkey" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."dashboard_repositories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_pr_review_settings" ADD CONSTRAINT "repository_pr_review_settings_provider_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE restrict ON UPDATE no action;