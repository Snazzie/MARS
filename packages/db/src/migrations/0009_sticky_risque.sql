CREATE TABLE "global_failure_analysis_settings" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"enable_all" boolean DEFAULT false NOT NULL,
	"provider_id" uuid,
	"enabled_since" timestamp with time zone,
	CONSTRAINT "global_failure_analysis_settings_singleton_check" CHECK (singleton),
	CONSTRAINT "global_failure_analysis_settings_enabled_provider_check" CHECK (NOT enable_all OR (provider_id IS NOT NULL AND enabled_since IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "global_failure_analysis_settings" ADD CONSTRAINT "global_failure_analysis_settings_provider_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE restrict ON UPDATE no action;