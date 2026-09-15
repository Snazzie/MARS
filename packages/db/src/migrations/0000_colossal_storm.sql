CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"type" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"lease_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "commands_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'sent'::text, 'acknowledged'::text, 'completed'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "control_plane_config" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"public_base_url" text,
	"setup_code_hash" "bytea",
	"setup_completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_plane_config_singleton_check" CHECK (singleton)
);
--> statement-breakpoint
CREATE TABLE "dashboard_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"repository_selection" text,
	"github_account_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_installations_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "dashboard_installations_organization_id_github_installation_key" UNIQUE("organization_id","github_installation_id"),
	CONSTRAINT "dashboard_installations_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text])),
	CONSTRAINT "dashboard_installations_repository_selection_check" CHECK (repository_selection = ANY (ARRAY['all'::text, 'selected'::text]))
);
--> statement-breakpoint
CREATE TABLE "dashboard_job_resource_samples" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"cpu_usage_percent" numeric(5, 2) NOT NULL,
	"cpu_time_ms" bigint NOT NULL,
	"memory_working_set_bytes" bigint NOT NULL,
	"memory_limit_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_job_resource_samples_pkey" PRIMARY KEY("organization_id","job_id","occurred_at"),
	CONSTRAINT "dashboard_job_resource_samples_cpu_usage_percent_check" CHECK ((cpu_usage_percent >= (0)::numeric) AND (cpu_usage_percent <= (100)::numeric)),
	CONSTRAINT "dashboard_job_resource_samples_cpu_time_ms_check" CHECK (cpu_time_ms >= 0),
	CONSTRAINT "dashboard_job_resource_samples_memory_working_set_bytes_check" CHECK (memory_working_set_bytes >= 0),
	CONSTRAINT "dashboard_job_resource_samples_memory_limit_bytes_check" CHECK (memory_limit_bytes > 0)
);
--> statement-breakpoint
CREATE TABLE "dashboard_job_steps" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"number" integer NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "dashboard_job_steps_pkey" PRIMARY KEY("organization_id","run_id","job_id","id"),
	CONSTRAINT "dashboard_job_steps_number_check" CHECK (number >= 0),
	CONSTRAINT "dashboard_job_steps_duration_ms_check" CHECK (duration_ms >= 0)
);
--> statement-breakpoint
CREATE TABLE "dashboard_job_timing_snapshots" (
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"github_job_id" bigint NOT NULL,
	"repository_name" text NOT NULL,
	"workflow_name" text NOT NULL,
	"job_name" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"driver" text NOT NULL,
	"runtime_boundary" text,
	"pool_id" uuid,
	"artifact_digest" text,
	"outcome" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"queue_duration_ms" bigint NOT NULL,
	"startup_duration_ms" bigint NOT NULL,
	"execution_duration_ms" bigint NOT NULL,
	"cleanup_duration_ms" bigint NOT NULL,
	"total_duration_ms" bigint NOT NULL,
	"requested_vcpu" bigint NOT NULL,
	"requested_memory_bytes" bigint NOT NULL,
	"requested_storage_bytes" bigint NOT NULL,
	"requested_concurrency" bigint NOT NULL,
	"observed_vcpu" bigint,
	"observed_memory_bytes" bigint,
	"observed_storage_bytes" bigint,
	"effective_concurrency" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"telemetry_state" text DEFAULT 'unavailable' NOT NULL,
	"telemetry_sample_count" bigint DEFAULT 0 NOT NULL,
	"cpu_average_percent" numeric(5, 2),
	"cpu_p50_percent" numeric(5, 2),
	"cpu_p95_percent" numeric(5, 2),
	"cpu_peak_percent" numeric(5, 2),
	"cpu_time_ms" bigint,
	"memory_average_bytes" bigint,
	"memory_peak_bytes" bigint,
	CONSTRAINT "dashboard_job_timing_snapshots_pkey" PRIMARY KEY("organization_id","job_id"),
	CONSTRAINT "dashboard_job_timing_snapshots_queue_duration_ms_check" CHECK (queue_duration_ms >= 0),
	CONSTRAINT "dashboard_job_timing_snapshots_startup_duration_ms_check" CHECK (startup_duration_ms >= 0),
	CONSTRAINT "dashboard_job_timing_snapshots_execution_duration_ms_check" CHECK (execution_duration_ms >= 0),
	CONSTRAINT "dashboard_job_timing_snapshots_cleanup_duration_ms_check" CHECK (cleanup_duration_ms >= 0),
	CONSTRAINT "dashboard_job_timing_snapshots_total_duration_ms_check" CHECK (total_duration_ms >= 0),
	CONSTRAINT "dashboard_job_timing_snapshots_requested_vcpu_check" CHECK (requested_vcpu > 0),
	CONSTRAINT "dashboard_job_timing_snapshots_requested_memory_bytes_check" CHECK (requested_memory_bytes > 0),
	CONSTRAINT "dashboard_job_timing_snapshots_requested_storage_bytes_check" CHECK (requested_storage_bytes > 0),
	CONSTRAINT "dashboard_job_timing_snapshots_requested_concurrency_check" CHECK (requested_concurrency > 0),
	CONSTRAINT "dashboard_job_timing_snapshots_effective_concurrency_check" CHECK (effective_concurrency > 0)
);
--> statement-breakpoint
CREATE TABLE "dashboard_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"github_job_id" bigint NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"stage" text NOT NULL,
	"runner_name" text,
	"requested" jsonb NOT NULL,
	"requested_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed" jsonb,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"logs_state" text DEFAULT 'pending' NOT NULL,
	"logs_synced_at" timestamp with time zone,
	"logs_error" text,
	"logs_version" integer DEFAULT 0 NOT NULL,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dashboard_jobs_org_run_id_key" UNIQUE("organization_id","run_id","id"),
	CONSTRAINT "dashboard_jobs_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "dashboard_jobs_organization_id_github_job_id_key" UNIQUE("organization_id","github_job_id"),
	CONSTRAINT "dashboard_jobs_run_attempt_check" CHECK (run_attempt > 0)
);
--> statement-breakpoint
CREATE TABLE "dashboard_log_chunks" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"content" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_log_chunks_pkey" PRIMARY KEY("organization_id","run_id","job_id","sequence"),
	CONSTRAINT "dashboard_log_chunks_sequence_check" CHECK (sequence >= 0)
);
--> statement-breakpoint
CREATE TABLE "dashboard_mutations" (
	"organization_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_mutations_pkey" PRIMARY KEY("organization_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "dashboard_outbox_invalidations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"keys" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_outbox_invalidations_organization_id_sequence_key" UNIQUE("organization_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "dashboard_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discovery_error" text,
	"discovery_retry_at" timestamp with time zone,
	CONSTRAINT "dashboard_repositories_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "dashboard_repositories_organization_id_github_repository_id_key" UNIQUE("organization_id","github_repository_id"),
	CONSTRAINT "dashboard_repositories_visibility_check" CHECK (visibility = ANY (ARRAY['private'::text, 'internal'::text, 'public'::text]))
);
--> statement-breakpoint
CREATE TABLE "dashboard_resource_observations" (
	"organization_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vcpu_actual" bigint NOT NULL,
	"vcpu_reserved" bigint NOT NULL,
	"vcpu_free" bigint NOT NULL,
	"memory_actual" bigint NOT NULL,
	"memory_reserved" bigint NOT NULL,
	"memory_free" bigint NOT NULL,
	"storage_actual" bigint NOT NULL,
	"storage_reserved" bigint NOT NULL,
	"storage_free" bigint NOT NULL,
	"pods_actual" bigint NOT NULL,
	"pods_reserved" bigint NOT NULL,
	"pods_free" bigint NOT NULL,
	CONSTRAINT "dashboard_resource_observations_pkey" PRIMARY KEY("organization_id","worker_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "dashboard_run_stages" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "dashboard_run_stages_pkey" PRIMARY KEY("organization_id","run_id","stage")
);
--> statement-breakpoint
CREATE TABLE "dashboard_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"github_run_id" bigint NOT NULL,
	"run_number" bigint NOT NULL,
	"workflow_name" text NOT NULL,
	"event" text NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"actor_login" text NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"runtime_boundary" text,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dashboard_runs_organization_id_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "dashboard_runs_organization_id_github_run_id_key" UNIQUE("organization_id","github_run_id"),
	CONSTRAINT "dashboard_runs_run_attempt_check" CHECK (run_attempt > 0)
);
--> statement-breakpoint
CREATE TABLE "dashboard_step_log_chunks" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"content" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_step_log_chunks_pkey" PRIMARY KEY("organization_id","run_id","job_id","step_id","sequence"),
	CONSTRAINT "dashboard_step_log_chunks_sequence_check" CHECK (sequence >= 0)
);
--> statement-breakpoint
CREATE TABLE "github_app_config" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"client_id" text,
	"encrypted_pem" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"encrypted_webhook_secret" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_config_singleton_check" CHECK (singleton)
);
--> statement-breakpoint
CREATE TABLE "github_discovery_checkpoints" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"completed_run_id" bigint NOT NULL,
	"completed_run_attempt" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_discovery_checkpoints_completed_run_attempt_check" CHECK (completed_run_attempt > 0)
);
--> statement-breakpoint
CREATE TABLE "github_setup_states" (
	"state_hash" "bytea" PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"idempotency_key" text,
	"encrypted_state" text,
	"encrypted_pkce_verifier" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "github_setup_states_purpose_check" CHECK (purpose = ANY (ARRAY['oauth'::text, 'manifest'::text, 'install'::text, 'organization_install'::text]))
);
--> statement-breakpoint
CREATE TABLE "job_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "job_claims_lease_id_key" UNIQUE("lease_id"),
	CONSTRAINT "job_claims_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK (role = ANY (ARRAY['owner'::text, 'member'::text]))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_org_id" bigint NOT NULL,
	"login" text NOT NULL,
	"github_account_type" text DEFAULT 'Organization' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_github_org_id_key" UNIQUE("github_org_id"),
	CONSTRAINT "organizations_github_account_type_check" CHECK (github_account_type = ANY (ARRAY['User'::text, 'Organization'::text]))
);
--> statement-breakpoint
CREATE TABLE "runner_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"routing_key" text NOT NULL,
	"github_job_id" bigint,
	"state" text NOT NULL,
	"requested" jsonb NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"runtime_instance_id" text,
	"terminal_result" jsonb,
	"cleanup_state" text DEFAULT 'none' NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_leases_github_job_id_key" UNIQUE("github_job_id")
);
--> statement-breakpoint
CREATE TABLE "runner_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"worker_id" uuid,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"driver" text NOT NULL,
	"image_digest" text NOT NULL,
	"resources" jsonb NOT NULL,
	"labels" jsonb NOT NULL,
	"trigger_label" text,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "system_onboarding" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"admin_user_id" uuid,
	"worker_id" uuid,
	"organization_id" uuid,
	"completed_at" timestamp with time zone,
	"verification_repository_id" uuid,
	"verification_pool_id" uuid,
	"verification_workflow_path" text,
	"verification_github_run_id" bigint,
	"verification_started_at" timestamp with time zone,
	"verification_error" text,
	CONSTRAINT "system_onboarding_singleton_check" CHECK (singleton)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"is_global_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_user_id_key" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_name" text DEFAULT 'unknown' NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_bootstrap_credentials" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"generation" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"rotated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "worker_bootstrap_credentials_singleton_check" CHECK (singleton),
	CONSTRAINT "worker_bootstrap_credentials_generation_check" CHECK (generation > 0)
);
--> statement-breakpoint
CREATE TABLE "worker_cache_entries" (
	"worker_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"cache_key_preview" text NOT NULL,
	"cache_key_hash" text NOT NULL,
	"scope_preview" text NOT NULL,
	"scope_hash" text NOT NULL,
	"version_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_accessed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"observed_generation" uuid NOT NULL,
	CONSTRAINT "worker_cache_entries_pkey" PRIMARY KEY("worker_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "worker_cache_snapshot_entries" (
	"worker_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"entry_id" uuid NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"cache_key_preview" text NOT NULL,
	"cache_key_hash" text NOT NULL,
	"scope_preview" text NOT NULL,
	"scope_hash" text NOT NULL,
	"version_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_accessed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"observed_generation" uuid NOT NULL,
	"staged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_cache_snapshot_entries_pkey" PRIMARY KEY("worker_id","snapshot_id","sequence","entry_id")
);
--> statement-breakpoint
CREATE TABLE "worker_cache_status" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"proxy_origin" text NOT NULL,
	"cache_base_url" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"entry_count" bigint DEFAULT 0 NOT NULL,
	"hit_count" bigint DEFAULT 0 NOT NULL,
	"miss_count" bigint DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"error" text,
	"active_snapshot_id" uuid,
	"active_snapshot_started_at" timestamp with time zone,
	"last_completed_snapshot_id" uuid,
	"runner_cache_enabled" boolean,
	"runner_cache_max_gib" bigint,
	"runner_cache_size_bytes" bigint,
	"runner_cache_entry_count" bigint,
	"runner_cache_hit_count" bigint DEFAULT 0 NOT NULL,
	"runner_cache_miss_count" bigint DEFAULT 0 NOT NULL,
	"runner_cache_observed_at" timestamp with time zone,
	CONSTRAINT "worker_cache_status_size_bytes_check" CHECK (size_bytes >= 0),
	CONSTRAINT "worker_cache_status_entry_count_check" CHECK (entry_count >= 0),
	CONSTRAINT "worker_cache_status_runner_size_bytes_check" CHECK (runner_cache_size_bytes IS NULL OR runner_cache_size_bytes >= 0),
	CONSTRAINT "worker_cache_status_runner_entry_count_check" CHECK (runner_cache_entry_count IS NULL OR runner_cache_entry_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "worker_mutations" (
	"worker_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_mutations_pkey" PRIMARY KEY("worker_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"guest_platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"admission_state" text NOT NULL,
	"connection_state" text DEFAULT 'offline' NOT NULL,
	"configuration_state" text DEFAULT 'unconfigured' NOT NULL,
	"public_key" text,
	"encryption_public_key" text,
	"fingerprint" text,
	"limits" jsonb,
	"doctor" jsonb,
	"vm_uuid" text,
	"enrollment_code_hash" "bytea",
	"enrollment_authenticated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"machine_uuid" text,
	"last_requested_at" timestamp with time zone,
	"configuration_revision" text,
	"configuration_command_id" uuid,
	"draining" boolean DEFAULT false NOT NULL,
	"preserve_leases" boolean DEFAULT false NOT NULL,
	"desired_configuration" jsonb,
	"applied_configuration_revision" text,
	"configuration_applied_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"doctor_observed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_installations" ADD CONSTRAINT "dashboard_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_resource_samples" ADD CONSTRAINT "dashboard_job_resource_samples_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_resource_samples" ADD CONSTRAINT "dashboard_job_resource_samples_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."runner_leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_resource_samples" ADD CONSTRAINT "dashboard_job_resource_sample_organization_id_run_id_job_i_fkey" FOREIGN KEY ("organization_id","run_id","job_id") REFERENCES "public"."dashboard_jobs"("organization_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_steps" ADD CONSTRAINT "dashboard_job_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_steps" ADD CONSTRAINT "dashboard_job_steps_organization_id_run_id_job_id_fkey" FOREIGN KEY ("organization_id","run_id","job_id") REFERENCES "public"."dashboard_jobs"("organization_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_timing_snapshots" ADD CONSTRAINT "dashboard_job_timing_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_timing_snapshots" ADD CONSTRAINT "dashboard_job_timing_snapshot_organization_id_run_id_job_i_fkey" FOREIGN KEY ("organization_id","run_id","job_id") REFERENCES "public"."dashboard_jobs"("organization_id","run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_job_timing_snapshots" ADD CONSTRAINT "dashboard_job_timing_snapshots_organization_id_run_id_fkey" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."dashboard_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_jobs" ADD CONSTRAINT "dashboard_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_jobs" ADD CONSTRAINT "dashboard_jobs_organization_id_run_id_fkey" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."dashboard_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_log_chunks" ADD CONSTRAINT "dashboard_log_chunks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_mutations" ADD CONSTRAINT "dashboard_mutations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_outbox_invalidations" ADD CONSTRAINT "dashboard_outbox_invalidations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_repositories" ADD CONSTRAINT "dashboard_repositories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_repositories" ADD CONSTRAINT "dashboard_repositories_organization_id_installation_id_fkey" FOREIGN KEY ("organization_id","installation_id") REFERENCES "public"."dashboard_installations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_resource_observations" ADD CONSTRAINT "dashboard_resource_observations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_resource_observations" ADD CONSTRAINT "dashboard_resource_observations_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_run_stages" ADD CONSTRAINT "dashboard_run_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_run_stages" ADD CONSTRAINT "dashboard_run_stages_organization_id_run_id_fkey" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."dashboard_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_runs" ADD CONSTRAINT "dashboard_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_runs" ADD CONSTRAINT "dashboard_runs_organization_id_repository_id_fkey" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."dashboard_repositories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_step_log_chunks" ADD CONSTRAINT "dashboard_step_log_chunks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_step_log_chunks" ADD CONSTRAINT "dashboard_step_log_chunks_organization_id_run_id_job_id_st_fkey" FOREIGN KEY ("organization_id","run_id","job_id","step_id") REFERENCES "public"."dashboard_job_steps"("organization_id","run_id","job_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_discovery_checkpoints" ADD CONSTRAINT "github_discovery_checkpoints_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "public"."dashboard_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_claims" ADD CONSTRAINT "job_claims_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."runner_leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_leases" ADD CONSTRAINT "runner_leases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_leases" ADD CONSTRAINT "runner_leases_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "public"."runner_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_leases" ADD CONSTRAINT "runner_leases_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pools" ADD CONSTRAINT "runner_pools_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pools" ADD CONSTRAINT "runner_pools_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_onboarding" ADD CONSTRAINT "system_onboarding_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_onboarding" ADD CONSTRAINT "system_onboarding_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_onboarding" ADD CONSTRAINT "system_onboarding_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_onboarding" ADD CONSTRAINT "system_onboarding_verification_repository_id_fkey" FOREIGN KEY ("verification_repository_id") REFERENCES "public"."dashboard_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_onboarding" ADD CONSTRAINT "system_onboarding_verification_pool_id_fkey" FOREIGN KEY ("verification_pool_id") REFERENCES "public"."runner_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_bootstrap_credentials" ADD CONSTRAINT "worker_bootstrap_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_bootstrap_credentials" ADD CONSTRAINT "worker_bootstrap_credentials_rotated_by_fkey" FOREIGN KEY ("rotated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_cache_entries" ADD CONSTRAINT "worker_cache_entries_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_cache_snapshot_entries" ADD CONSTRAINT "worker_cache_snapshot_entries_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_cache_status" ADD CONSTRAINT "worker_cache_status_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_mutations" ADD CONSTRAINT "worker_mutations_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_job_resource_samples_job_time_idx" ON "dashboard_job_resource_samples" USING btree ("organization_id","job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "dashboard_job_resource_samples_retention_idx" ON "dashboard_job_resource_samples" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_job_steps_number_idx" ON "dashboard_job_steps" USING btree ("organization_id","run_id","job_id","number");--> statement-breakpoint
CREATE INDEX "dashboard_job_steps_order_idx" ON "dashboard_job_steps" USING btree ("organization_id","run_id","job_id","number","id");--> statement-breakpoint
CREATE INDEX "dashboard_job_timing_worker_idx" ON "dashboard_job_timing_snapshots" USING btree ("organization_id","worker_id","completed_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "dashboard_job_timing_completed_idx" ON "dashboard_job_timing_snapshots" USING btree ("organization_id","completed_at" DESC NULLS FIRST,"job_id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "dashboard_job_timing_dimensions_idx" ON "dashboard_job_timing_snapshots" USING btree ("organization_id","platform","driver","requested_vcpu","effective_concurrency","completed_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_jobs_github_id_idx" ON "dashboard_jobs" USING btree ("organization_id","github_job_id") WHERE (github_job_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "dashboard_jobs_reconcile_idx" ON "dashboard_jobs" USING btree ("organization_id","status","queued_at","github_job_id");--> statement-breakpoint
CREATE INDEX "dashboard_logs_org_run_job_idx" ON "dashboard_log_chunks" USING btree ("organization_id","run_id","job_id","sequence");--> statement-breakpoint
CREATE INDEX "dashboard_outbox_org_sequence_idx" ON "dashboard_outbox_invalidations" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_repositories_github_id_idx" ON "dashboard_repositories" USING btree ("organization_id","github_repository_id") WHERE (github_repository_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "dashboard_resources_org_worker_idx" ON "dashboard_resource_observations" USING btree ("organization_id","worker_id","observed_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_runs_github_id_idx" ON "dashboard_runs" USING btree ("organization_id","github_run_id") WHERE (github_run_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "dashboard_runs_org_queued_idx" ON "dashboard_runs" USING btree ("organization_id","queued_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "dashboard_step_logs_order_idx" ON "dashboard_step_log_chunks" USING btree ("organization_id","run_id","job_id","step_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_github_account_idx" ON "organizations" USING btree ("github_account_type","github_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pools_global_name_idx" ON "runner_pools" USING btree ("name") WHERE (organization_id IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pools_global_trigger_idx" ON "runner_pools" USING btree ("trigger_label") WHERE ((organization_id IS NULL) AND (trigger_label IS NOT NULL));--> statement-breakpoint
CREATE INDEX "webhook_deliveries_state_idx" ON "webhook_deliveries" USING btree ("state","received_at");--> statement-breakpoint
CREATE INDEX "worker_cache_entries_order_idx" ON "worker_cache_entries" USING btree ("worker_id","last_accessed_at","entry_id");--> statement-breakpoint
CREATE INDEX "worker_cache_entries_repository_idx" ON "worker_cache_entries" USING btree ("worker_id","github_repository_id");--> statement-breakpoint
CREATE INDEX "worker_cache_snapshot_entries_idx" ON "worker_cache_snapshot_entries" USING btree ("worker_id","snapshot_id","sequence","entry_id");--> statement-breakpoint
CREATE INDEX "worker_cache_snapshot_entries_staged_at_idx" ON "worker_cache_snapshot_entries" USING btree ("staged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_active_fingerprint_idx" ON "workers" USING btree ("fingerprint") WHERE ((fingerprint IS NOT NULL) AND (admission_state = ANY (ARRAY['pending'::text, 'adopted'::text])));--> statement-breakpoint
CREATE UNIQUE INDEX "workers_active_machine_uuid_idx" ON "workers" USING btree ("machine_uuid") WHERE ((machine_uuid IS NOT NULL) AND (admission_state = ANY (ARRAY['pending'::text, 'adopted'::text])));--> statement-breakpoint
CREATE UNIQUE INDEX "workers_active_vm_uuid_idx" ON "workers" USING btree ("vm_uuid") WHERE ((vm_uuid IS NOT NULL) AND (admission_state = ANY (ARRAY['pending'::text, 'adopted'::text])));