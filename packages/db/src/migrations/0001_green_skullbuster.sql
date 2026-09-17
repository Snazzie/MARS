CREATE TABLE "dashboard_action_edges" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"from_job_id" uuid NOT NULL,
	"to_job_id" uuid NOT NULL,
	CONSTRAINT "dashboard_action_edges_pkey" PRIMARY KEY("organization_id","run_id","from_job_id","to_job_id"),
	CONSTRAINT "dashboard_action_edges_distinct_jobs_check" CHECK (from_job_id <> to_job_id)
);
--> statement-breakpoint
ALTER TABLE "dashboard_runs" ADD COLUMN "action_graph_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dashboard_action_edges" ADD CONSTRAINT "dashboard_action_edges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_action_edges" ADD CONSTRAINT "dashboard_action_edges_organization_id_run_id_fkey" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."dashboard_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_action_edges" ADD CONSTRAINT "dashboard_action_edges_organization_id_from_job_id_fkey" FOREIGN KEY ("organization_id","from_job_id") REFERENCES "public"."dashboard_jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_action_edges" ADD CONSTRAINT "dashboard_action_edges_organization_id_to_job_id_fkey" FOREIGN KEY ("organization_id","to_job_id") REFERENCES "public"."dashboard_jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;