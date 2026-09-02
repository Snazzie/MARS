import { pgTable, unique, uuid, bigint, text, boolean, timestamp, foreignKey, check, integer, uniqueIndex, jsonb, index, primaryKey, numeric, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });



export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
	login: text().notNull(),
	isGlobalAdmin: boolean("is_global_admin").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("users_github_user_id_key").on(table.githubUserId),
]);

export const sessions = pgTable("sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tokenHash: bytea("token_hash").notNull(),
	userId: uuid("user_id").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "sessions_user_id_fkey"
		}).onDelete("cascade"),
	unique("sessions_token_hash_key").on(table.tokenHash),
]);

export const workerBootstrapCredentials = pgTable("worker_bootstrap_credentials", {
	singleton: boolean().default(true).primaryKey().notNull(),
	codeHash: bytea("code_hash").notNull(),
	generation: integer().notNull(),
	createdBy: uuid("created_by").notNull(),
	rotatedBy: uuid("rotated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: 'string' }),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "worker_bootstrap_credentials_created_by_fkey"
		}),
	foreignKey({
			columns: [table.rotatedBy],
			foreignColumns: [users.id],
			name: "worker_bootstrap_credentials_rotated_by_fkey"
		}),
	check("worker_bootstrap_credentials_singleton_check", sql`CHECK (singleton)`),
	check("worker_bootstrap_credentials_generation_check", sql`generation > 0`),
]);

export const organizations = pgTable("organizations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubOrgId: bigint("github_org_id", { mode: "number" }).notNull(),
	login: text().notNull(),
	githubAccountType: text("github_account_type").default('Organization').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("organizations_github_account_idx").using("btree", table.githubAccountType.asc().nullsLast().op("int8_ops"), table.githubOrgId.asc().nullsLast().op("int8_ops")),
	unique("organizations_github_org_id_key").on(table.githubOrgId),
	check("organizations_github_account_type_check", sql`github_account_type = ANY (ARRAY['User'::text, 'Organization'::text])`),
]);

export const runnerPools = pgTable("runner_pools", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id"),
	workerId: uuid("worker_id"),
	name: text().notNull(),
	platform: text().notNull(),
	driver: text().notNull(),
	imageDigest: text("image_digest").notNull(),
	resources: jsonb().notNull(),
	labels: jsonb().notNull(),
	triggerLabel: text("trigger_label"),
	enabled: boolean().default(false).notNull(),
}, (table) => [
	uniqueIndex("runner_pools_global_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")).where(sql`(organization_id IS NULL)`),
	uniqueIndex("runner_pools_global_trigger_idx").using("btree", table.triggerLabel.asc().nullsLast().op("text_ops")).where(sql`((organization_id IS NULL) AND (trigger_label IS NOT NULL))`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "runner_pools_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.workerId],
			foreignColumns: [workers.id],
			name: "runner_pools_worker_id_fkey"
		}),
]);

export const workers = pgTable("workers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	platform: text().notNull(),
	guestPlatforms: jsonb("guest_platforms").default([]).notNull(),
	admissionState: text("admission_state").notNull(),
	connectionState: text("connection_state").default('offline').notNull(),
	configurationState: text("configuration_state").default('unconfigured').notNull(),
	publicKey: text("public_key"),
	encryptionPublicKey: text("encryption_public_key"),
	fingerprint: text(),
	limits: jsonb(),
	doctor: jsonb(),
	vmUuid: text("vm_uuid"),
	enrollmentCodeHash: bytea("enrollment_code_hash"),
	enrollmentAuthenticatedAt: timestamp("enrollment_authenticated_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	machineUuid: text("machine_uuid"),
	lastRequestedAt: timestamp("last_requested_at", { withTimezone: true, mode: 'string' }),
	configurationRevision: text("configuration_revision"),
	configurationCommandId: uuid("configuration_command_id"),
	draining: boolean().default(false).notNull(),
	preserveLeases: boolean("preserve_leases").default(false).notNull(),
	desiredConfiguration: jsonb("desired_configuration"),
	appliedConfigurationRevision: text("applied_configuration_revision"),
	configurationAppliedAt: timestamp("configuration_applied_at", { withTimezone: true, mode: 'string' }),
	lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true, mode: 'string' }),
	doctorObservedAt: timestamp("doctor_observed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("workers_active_fingerprint_idx").using("btree", table.fingerprint.asc().nullsLast().op("text_ops")).where(sql`((fingerprint IS NOT NULL) AND (admission_state = ANY (ARRAY['pending'::text, 'adopted'::text])))`),
	uniqueIndex("workers_active_machine_uuid_idx").using("btree", table.machineUuid.asc().nullsLast().op("text_ops")).where(sql`((machine_uuid IS NOT NULL) AND (admission_state = ANY (ARRAY['pending'::text, 'adopted'::text])))`),
	uniqueIndex("workers_active_vm_uuid_idx").using("btree", table.vmUuid.asc().nullsLast().op("text_ops")).where(sql`((vm_uuid IS NOT NULL) AND (admission_state = ANY (ARRAY['pending'::text, 'adopted'::text])))`),
]);

export const runnerLeases = pgTable("runner_leases", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id").notNull(),
	poolId: uuid("pool_id").notNull(),
	workerId: uuid("worker_id").notNull(),
	routingKey: text("routing_key").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubJobId: bigint("github_job_id", { mode: "number" }),
	state: text().notNull(),
	requested: jsonb().notNull(),
	nonce: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	runtimeInstanceId: text("runtime_instance_id"),
	terminalResult: jsonb("terminal_result"),
	cleanupState: text("cleanup_state").default('none').notNull(),
	dispatchAttempts: integer("dispatch_attempts").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "runner_leases_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.poolId],
			foreignColumns: [runnerPools.id],
			name: "runner_leases_pool_id_fkey"
		}),
	foreignKey({
			columns: [table.workerId],
			foreignColumns: [workers.id],
			name: "runner_leases_worker_id_fkey"
		}),
	unique("runner_leases_github_job_id_key").on(table.githubJobId),
]);

export const jobClaims = pgTable("job_claims", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	leaseId: uuid("lease_id").notNull(),
	tokenHash: bytea("token_hash").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.leaseId],
			foreignColumns: [runnerLeases.id],
			name: "job_claims_lease_id_fkey"
		}).onDelete("cascade"),
	unique("job_claims_lease_id_key").on(table.leaseId),
	unique("job_claims_token_hash_key").on(table.tokenHash),
]);

export const auditEvents = pgTable("audit_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id"),
	actor: text().notNull(),
	type: text().notNull(),
	payload: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const commands = pgTable("commands", {
	id: uuid().primaryKey().notNull(),
	version: integer().notNull(),
	type: text().notNull(),
	workerId: uuid("worker_id").notNull(),
	leaseId: uuid("lease_id"),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	payload: jsonb().notNull(),
	state: text().default('pending').notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workerId],
			foreignColumns: [workers.id],
			name: "commands_worker_id_fkey"
		}).onDelete("cascade"),
	check("commands_state_check", sql`state = ANY (ARRAY['pending'::text, 'sent'::text, 'acknowledged'::text, 'completed'::text, 'failed'::text])`),
]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
	deliveryId: text("delivery_id").primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	installationId: bigint("installation_id", { mode: "number" }).notNull(),
	payload: jsonb().notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	eventName: text("event_name").default('unknown').notNull(),
	state: text().default('received').notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	lastError: text("last_error"),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("webhook_deliveries_state_idx").using("btree", table.state.asc().nullsLast().op("text_ops"), table.receivedAt.asc().nullsLast().op("text_ops")),
]);

export const dashboardInstallations = pgTable("dashboard_installations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubInstallationId: bigint("github_installation_id", { mode: "number" }).notNull(),
	state: text().default('pending').notNull(),
	repositorySelection: text("repository_selection"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubAccountId: bigint("github_account_id", { mode: "number" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_installations_organization_id_fkey"
		}).onDelete("cascade"),
	unique("dashboard_installations_organization_id_id_key").on(table.id, table.organizationId),
	unique("dashboard_installations_organization_id_github_installation_key").on(table.organizationId, table.githubInstallationId),
	check("dashboard_installations_state_check", sql`state = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text])`),
	check("dashboard_installations_repository_selection_check", sql`repository_selection = ANY (ARRAY['all'::text, 'selected'::text])`),
]);

export const controlPlaneConfig = pgTable("control_plane_config", {
	singleton: boolean().default(true).primaryKey().notNull(),
	publicBaseUrl: text("public_base_url"),
	setupCodeHash: bytea("setup_code_hash"),
	setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("control_plane_config_singleton_check", sql`CHECK (singleton)`),
]);

export const githubAppConfig = pgTable("github_app_config", {
	singleton: boolean().default(true).primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	appId: bigint("app_id", { mode: "number" }).notNull(),
	slug: text().notNull(),
	clientId: text("client_id"),
	encryptedPem: text("encrypted_pem").notNull(),
	encryptedClientSecret: text("encrypted_client_secret").notNull(),
	encryptedWebhookSecret: text("encrypted_webhook_secret").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("github_app_config_singleton_check", sql`CHECK (singleton)`),
]);

export const dashboardRepositories = pgTable("dashboard_repositories", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id").notNull(),
	installationId: uuid("installation_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
	name: text().notNull(),
	fullName: text("full_name").notNull(),
	visibility: text().default('public').notNull(),
	available: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	discoveryError: text("discovery_error"),
	discoveryRetryAt: timestamp("discovery_retry_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("dashboard_repositories_github_id_idx").using("btree", table.organizationId.asc().nullsLast().op("int8_ops"), table.githubRepositoryId.asc().nullsLast().op("uuid_ops")).where(sql`(github_repository_id IS NOT NULL)`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_repositories_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.installationId],
			foreignColumns: [dashboardInstallations.id, dashboardInstallations.organizationId],
			name: "dashboard_repositories_organization_id_installation_id_fkey"
		}).onDelete("cascade"),
	unique("dashboard_repositories_organization_id_id_key").on(table.id, table.organizationId),
	unique("dashboard_repositories_organization_id_github_repository_id_key").on(table.organizationId, table.githubRepositoryId),
	check("dashboard_repositories_visibility_check", sql`visibility = ANY (ARRAY['private'::text, 'internal'::text, 'public'::text])`),
]);

export const githubDiscoveryCheckpoints = pgTable("github_discovery_checkpoints", {
	repositoryId: uuid("repository_id").primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	completedRunId: bigint("completed_run_id", { mode: "number" }).notNull(),
	completedRunAttempt: integer("completed_run_attempt").default(1).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.repositoryId],
			foreignColumns: [dashboardRepositories.id],
			name: "github_discovery_checkpoints_repository_id_fkey"
		}).onDelete("cascade"),
	check("github_discovery_checkpoints_completed_run_attempt_check", sql`completed_run_attempt > 0`),
]);

export const dashboardRuns = pgTable("dashboard_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id").notNull(),
	repositoryId: uuid("repository_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubRunId: bigint("github_run_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	runNumber: bigint("run_number", { mode: "number" }).notNull(),
	workflowName: text("workflow_name").notNull(),
	event: text().notNull(),
	branch: text().notNull(),
	commitSha: text("commit_sha").notNull(),
	actorLogin: text("actor_login").notNull(),
	status: text().notNull(),
	conclusion: text(),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	runtimeBoundary: text("runtime_boundary"),
	runAttempt: integer("run_attempt").default(1).notNull(),
}, (table) => [
	uniqueIndex("dashboard_runs_github_id_idx").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops"), table.githubRunId.asc().nullsLast().op("uuid_ops")).where(sql`(github_run_id IS NOT NULL)`),
	index("dashboard_runs_org_queued_idx").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops"), table.queuedAt.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_runs_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.repositoryId],
			foreignColumns: [dashboardRepositories.id, dashboardRepositories.organizationId],
			name: "dashboard_runs_organization_id_repository_id_fkey"
		}).onDelete("cascade"),
	unique("dashboard_runs_organization_id_id_key").on(table.id, table.organizationId),
	unique("dashboard_runs_organization_id_github_run_id_key").on(table.organizationId, table.githubRunId),
	check("dashboard_runs_run_attempt_check", sql`run_attempt > 0`),
]);

export const dashboardJobs = pgTable("dashboard_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id").notNull(),
	runId: uuid("run_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubJobId: bigint("github_job_id", { mode: "number" }).notNull(),
	name: text().notNull(),
	status: text().notNull(),
	conclusion: text(),
	stage: text().notNull(),
	runnerName: text("runner_name"),
	requested: jsonb().notNull(),
	requestedLabels: jsonb("requested_labels").default([]).notNull(),
	observed: jsonb(),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	logsState: text("logs_state").default('pending').notNull(),
	logsSyncedAt: timestamp("logs_synced_at", { withTimezone: true, mode: 'string' }),
	logsError: text("logs_error"),
	logsVersion: integer("logs_version").default(0).notNull(),
	runAttempt: integer("run_attempt").default(1).notNull(),
}, (table) => [
	uniqueIndex("dashboard_jobs_github_id_idx").using("btree", table.organizationId.asc().nullsLast().op("int8_ops"), table.githubJobId.asc().nullsLast().op("int8_ops")).where(sql`(github_job_id IS NOT NULL)`),
	index("dashboard_jobs_org_run_idx").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops"), table.runId.asc().nullsLast().op("uuid_ops")),
	index("dashboard_jobs_reconcile_idx").using("btree", table.organizationId.asc().nullsLast().op("timestamptz_ops"), table.status.asc().nullsLast().op("timestamptz_ops"), table.queuedAt.asc().nullsLast().op("uuid_ops"), table.githubJobId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_jobs_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.runId],
			foreignColumns: [dashboardRuns.id, dashboardRuns.organizationId],
			name: "dashboard_jobs_organization_id_run_id_fkey"
		}).onDelete("cascade"),
	unique("dashboard_jobs_organization_id_id_key").on(table.id, table.organizationId),
	unique("dashboard_jobs_organization_id_github_job_id_key").on(table.organizationId, table.githubJobId),
	check("dashboard_jobs_run_attempt_check", sql`run_attempt > 0`),
]);


export const dashboardOutboxInvalidations = pgTable("dashboard_outbox_invalidations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: uuid("organization_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sequence: bigint({ mode: "number" }).notNull(),
	keys: jsonb().notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("dashboard_outbox_org_sequence_idx").using("btree", table.organizationId.asc().nullsLast().op("int8_ops"), table.sequence.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_outbox_invalidations_organization_id_fkey"
		}).onDelete("cascade"),
	unique("dashboard_outbox_invalidations_organization_id_sequence_key").on(table.organizationId, table.sequence),
]);

export const organizationSettings = pgTable("organization_settings", {
	organizationId: uuid("organization_id").primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxVcpuPerPod: bigint("max_vcpu_per_pod", { mode: "number" }).default(1).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxMemoryBytesPerPod: bigint("max_memory_bytes_per_pod", { mode: "number" }).default(1).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxStorageBytesPerPod: bigint("max_storage_bytes_per_pod", { mode: "number" }).default(1).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	maxConcurrentPods: bigint("max_concurrent_pods", { mode: "number" }).default(1).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_settings_organization_id_fkey"
		}).onDelete("cascade"),
	check("organization_settings_max_vcpu_per_pod_check", sql`max_vcpu_per_pod > 0`),
	check("organization_settings_max_memory_bytes_per_pod_check", sql`max_memory_bytes_per_pod > 0`),
	check("organization_settings_max_storage_bytes_per_pod_check", sql`max_storage_bytes_per_pod > 0`),
	check("organization_settings_max_concurrent_pods_check", sql`max_concurrent_pods > 0`),
]);

export const schemaMigrations = pgTable("schema_migrations", {
	version: integer().primaryKey().notNull(),
	name: text().notNull(),
	checksum: text().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const githubSetupStates = pgTable("github_setup_states", {
	stateHash: bytea("state_hash").primaryKey().notNull(),
	purpose: text().notNull(),
	userId: uuid("user_id"),
	organizationId: uuid("organization_id"),
	idempotencyKey: text("idempotency_key"),
	encryptedState: text("encrypted_state"),
	encryptedPkceVerifier: text("encrypted_pkce_verifier"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	check("github_setup_states_purpose_check", sql`purpose = ANY (ARRAY['oauth'::text, 'manifest'::text, 'install'::text, 'organization_install'::text])`),
]);

export const systemOnboarding = pgTable("system_onboarding", {
	singleton: boolean().default(true).primaryKey().notNull(),
	adminUserId: uuid("admin_user_id"),
	workerId: uuid("worker_id"),
	organizationId: uuid("organization_id"),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	verificationRepositoryId: uuid("verification_repository_id"),
	verificationPoolId: uuid("verification_pool_id"),
	verificationWorkflowPath: text("verification_workflow_path"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	verificationGithubRunId: bigint("verification_github_run_id", { mode: "number" }),
	verificationStartedAt: timestamp("verification_started_at", { withTimezone: true, mode: 'string' }),
	verificationError: text("verification_error"),
}, (table) => [
	foreignKey({
			columns: [table.adminUserId],
			foreignColumns: [users.id],
			name: "system_onboarding_admin_user_id_fkey"
		}),
	foreignKey({
			columns: [table.workerId],
			foreignColumns: [workers.id],
			name: "system_onboarding_worker_id_fkey"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "system_onboarding_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.verificationRepositoryId],
			foreignColumns: [dashboardRepositories.id],
			name: "system_onboarding_verification_repository_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.verificationPoolId],
			foreignColumns: [runnerPools.id],
			name: "system_onboarding_verification_pool_id_fkey"
		}).onDelete("set null"),
	check("system_onboarding_singleton_check", sql`CHECK (singleton)`),
]);

export const memberships = pgTable("memberships", {
	organizationId: uuid("organization_id").notNull(),
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "memberships_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "memberships_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.userId], name: "memberships_pkey"}),
	check("memberships_role_check", sql`role = ANY (ARRAY['owner'::text, 'member'::text])`),
]);

export const workerMutations = pgTable("worker_mutations", {
	workerId: uuid("worker_id").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	response: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workerId],
			foreignColumns: [workers.id],
			name: "worker_mutations_worker_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.workerId, table.idempotencyKey], name: "worker_mutations_pkey"}),
]);

export const dashboardMutations = pgTable("dashboard_mutations", {
	organizationId: uuid("organization_id").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	response: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_mutations_organization_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.idempotencyKey], name: "dashboard_mutations_pkey"}),
]);

export const dashboardRunStages = pgTable("dashboard_run_stages", {
	organizationId: uuid("organization_id").notNull(),
	runId: uuid("run_id").notNull(),
	stage: text().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_run_stages_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.runId],
			foreignColumns: [dashboardRuns.id, dashboardRuns.organizationId],
			name: "dashboard_run_stages_organization_id_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.runId, table.stage], name: "dashboard_run_stages_pkey"}),
]);

export const dashboardLogChunks = pgTable("dashboard_log_chunks", {
	organizationId: uuid("organization_id").notNull(),
	runId: uuid("run_id").notNull(),
	jobId: uuid("job_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sequence: bigint({ mode: "number" }).notNull(),
	content: text().notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("dashboard_logs_org_run_job_idx").using("btree", table.organizationId.asc().nullsLast().op("int8_ops"), table.runId.asc().nullsLast().op("int8_ops"), table.jobId.asc().nullsLast().op("int8_ops"), table.sequence.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_log_chunks_organization_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.runId, table.jobId, table.sequence], name: "dashboard_log_chunks_pkey"}),
	check("dashboard_log_chunks_sequence_check", sql`sequence >= 0`),
]);

export const dashboardStepLogChunks = pgTable("dashboard_step_log_chunks", {
	organizationId: uuid("organization_id").notNull(),
	runId: uuid("run_id").notNull(),
	jobId: uuid("job_id").notNull(),
	stepId: text("step_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sequence: bigint({ mode: "number" }).notNull(),
	content: text().notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("dashboard_step_logs_order_idx").using("btree", table.organizationId.asc().nullsLast().op("int8_ops"), table.runId.asc().nullsLast().op("int8_ops"), table.jobId.asc().nullsLast().op("int8_ops"), table.stepId.asc().nullsLast().op("int8_ops"), table.sequence.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_step_log_chunks_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.runId, table.jobId, table.stepId],
			foreignColumns: [dashboardJobSteps.organizationId, dashboardJobSteps.runId, dashboardJobSteps.jobId, dashboardJobSteps.id],
			name: "dashboard_step_log_chunks_organization_id_run_id_job_id_st_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.runId, table.jobId, table.stepId, table.sequence], name: "dashboard_step_log_chunks_pkey"}),
	check("dashboard_step_log_chunks_sequence_check", sql`sequence >= 0`),
]);

export const dashboardJobResourceSamples = pgTable("dashboard_job_resource_samples", {
	organizationId: uuid("organization_id").notNull(),
	runId: uuid("run_id").notNull(),
	jobId: uuid("job_id").notNull(),
	leaseId: uuid("lease_id").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	cpuUsagePercent: numeric("cpu_usage_percent", { precision: 5, scale:  2 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cpuTimeMs: bigint("cpu_time_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryWorkingSetBytes: bigint("memory_working_set_bytes", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("dashboard_job_resource_samples_job_time_idx").using("btree", table.organizationId.asc().nullsLast().op("timestamptz_ops"), table.jobId.asc().nullsLast().op("uuid_ops"), table.occurredAt.asc().nullsLast().op("uuid_ops")),
	index("dashboard_job_resource_samples_retention_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_job_resource_samples_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.leaseId],
			foreignColumns: [runnerLeases.id],
			name: "dashboard_job_resource_samples_lease_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.runId, table.jobId],
			foreignColumns: [dashboardJobs.id, dashboardJobs.organizationId, dashboardJobs.runId],
			name: "dashboard_job_resource_sample_organization_id_run_id_job_i_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.jobId, table.occurredAt], name: "dashboard_job_resource_samples_pkey"}),
	check("dashboard_job_resource_samples_cpu_usage_percent_check", sql`(cpu_usage_percent >= (0)::numeric) AND (cpu_usage_percent <= (100)::numeric)`),
	check("dashboard_job_resource_samples_cpu_time_ms_check", sql`cpu_time_ms >= 0`),
	check("dashboard_job_resource_samples_memory_working_set_bytes_check", sql`memory_working_set_bytes >= 0`),
	check("dashboard_job_resource_samples_memory_limit_bytes_check", sql`memory_limit_bytes > 0`),
]);

export const dashboardJobSteps = pgTable("dashboard_job_steps", {
	organizationId: uuid("organization_id").notNull(),
	runId: uuid("run_id").notNull(),
	jobId: uuid("job_id").notNull(),
	id: text().notNull(),
	name: text().notNull(),
	number: integer().notNull(),
	status: text().notNull(),
	conclusion: text(),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	durationMs: bigint("duration_ms", { mode: "number" }).default(0).notNull(),
}, (table) => [
	uniqueIndex("dashboard_job_steps_number_idx").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops"), table.runId.asc().nullsLast().op("int4_ops"), table.jobId.asc().nullsLast().op("uuid_ops"), table.number.asc().nullsLast().op("uuid_ops")),
	index("dashboard_job_steps_order_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops"), table.runId.asc().nullsLast().op("int4_ops"), table.jobId.asc().nullsLast().op("text_ops"), table.number.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_job_steps_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.runId, table.jobId],
			foreignColumns: [dashboardJobs.id, dashboardJobs.organizationId, dashboardJobs.runId],
			name: "dashboard_job_steps_organization_id_run_id_job_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.runId, table.jobId, table.id], name: "dashboard_job_steps_pkey"}),
	check("dashboard_job_steps_number_check", sql`number >= 0`),
	check("dashboard_job_steps_duration_ms_check", sql`duration_ms >= 0`),
]);

export const dashboardResourceObservations = pgTable("dashboard_resource_observations", {
	organizationId: uuid("organization_id").notNull(),
	workerId: uuid("worker_id").notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	vcpuActual: bigint("vcpu_actual", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	vcpuReserved: bigint("vcpu_reserved", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	vcpuFree: bigint("vcpu_free", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryActual: bigint("memory_actual", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryReserved: bigint("memory_reserved", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryFree: bigint("memory_free", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storageActual: bigint("storage_actual", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storageReserved: bigint("storage_reserved", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	storageFree: bigint("storage_free", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	podsActual: bigint("pods_actual", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	podsReserved: bigint("pods_reserved", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	podsFree: bigint("pods_free", { mode: "number" }).notNull(),
}, (table) => [
	index("dashboard_resources_org_worker_idx").using("btree", table.organizationId.asc().nullsLast().op("timestamptz_ops"), table.workerId.asc().nullsLast().op("timestamptz_ops"), table.observedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_resource_observations_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workerId],
			foreignColumns: [workers.id],
			name: "dashboard_resource_observations_worker_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.workerId, table.observedAt], name: "dashboard_resource_observations_pkey"}),
]);

export const dashboardJobTimingSnapshots = pgTable("dashboard_job_timing_snapshots", {
	organizationId: uuid("organization_id").notNull(),
	jobId: uuid("job_id").notNull(),
	runId: uuid("run_id").notNull(),
	repositoryId: uuid("repository_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	githubJobId: bigint("github_job_id", { mode: "number" }).notNull(),
	repositoryName: text("repository_name").notNull(),
	workflowName: text("workflow_name").notNull(),
	jobName: text("job_name").notNull(),
	platform: text().notNull(),
	driver: text().notNull(),
	runtimeBoundary: text("runtime_boundary"),
	poolId: uuid("pool_id"),
	artifactDigest: text("artifact_digest"),
	outcome: text().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }).notNull(),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	queueDurationMs: bigint("queue_duration_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	startupDurationMs: bigint("startup_duration_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	executionDurationMs: bigint("execution_duration_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cleanupDurationMs: bigint("cleanup_duration_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalDurationMs: bigint("total_duration_ms", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requestedVcpu: bigint("requested_vcpu", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requestedMemoryBytes: bigint("requested_memory_bytes", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requestedStorageBytes: bigint("requested_storage_bytes", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requestedConcurrency: bigint("requested_concurrency", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	observedVcpu: bigint("observed_vcpu", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	observedMemoryBytes: bigint("observed_memory_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	observedStorageBytes: bigint("observed_storage_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	effectiveConcurrency: bigint("effective_concurrency", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	telemetryState: text("telemetry_state").default('unavailable').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	telemetrySampleCount: bigint("telemetry_sample_count", { mode: "number" }).default(0).notNull(),
	cpuAveragePercent: numeric("cpu_average_percent", { precision: 5, scale:  2 }),
	cpuP50Percent: numeric("cpu_p50_percent", { precision: 5, scale:  2 }),
	cpuP95Percent: numeric("cpu_p95_percent", { precision: 5, scale:  2 }),
	cpuPeakPercent: numeric("cpu_peak_percent", { precision: 5, scale:  2 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cpuTimeMs: bigint("cpu_time_ms", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryAverageBytes: bigint("memory_average_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	memoryPeakBytes: bigint("memory_peak_bytes", { mode: "number" }),
}, (table) => [
	index("dashboard_job_timing_completed_idx").using("btree", table.organizationId.asc().nullsLast().op("timestamptz_ops"), table.completedAt.desc().nullsFirst().op("timestamptz_ops"), table.jobId.desc().nullsFirst().op("timestamptz_ops")),
	index("dashboard_job_timing_dimensions_idx").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.platform.asc().nullsLast().op("text_ops"), table.driver.asc().nullsLast().op("text_ops"), table.requestedVcpu.asc().nullsLast().op("text_ops"), table.effectiveConcurrency.asc().nullsLast().op("text_ops"), table.completedAt.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "dashboard_job_timing_snapshots_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.jobId, table.runId],
			foreignColumns: [dashboardJobs.id, dashboardJobs.organizationId, dashboardJobs.runId],
			name: "dashboard_job_timing_snapshot_organization_id_run_id_job_i_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId, table.runId],
			foreignColumns: [dashboardRuns.id, dashboardRuns.organizationId],
			name: "dashboard_job_timing_snapshots_organization_id_run_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.organizationId, table.jobId], name: "dashboard_job_timing_snapshots_pkey"}),
	check("dashboard_job_timing_snapshots_queue_duration_ms_check", sql`queue_duration_ms >= 0`),
	check("dashboard_job_timing_snapshots_startup_duration_ms_check", sql`startup_duration_ms >= 0`),
	check("dashboard_job_timing_snapshots_execution_duration_ms_check", sql`execution_duration_ms >= 0`),
	check("dashboard_job_timing_snapshots_cleanup_duration_ms_check", sql`cleanup_duration_ms >= 0`),
	check("dashboard_job_timing_snapshots_total_duration_ms_check", sql`total_duration_ms >= 0`),
	check("dashboard_job_timing_snapshots_requested_vcpu_check", sql`requested_vcpu > 0`),
	check("dashboard_job_timing_snapshots_requested_memory_bytes_check", sql`requested_memory_bytes > 0`),
	check("dashboard_job_timing_snapshots_requested_storage_bytes_check", sql`requested_storage_bytes > 0`),
	check("dashboard_job_timing_snapshots_requested_concurrency_check", sql`requested_concurrency > 0`),
	check("dashboard_job_timing_snapshots_effective_concurrency_check", sql`effective_concurrency > 0`),
]);
export const workerCacheStatus = pgTable("worker_cache_status", {
	workerId: uuid("worker_id").primaryKey().notNull(),
	generation: uuid().notNull(),
	ready: boolean().default(false).notNull(),
	ttlSeconds: integer("ttl_seconds").notNull(),
	proxyOrigin: text("proxy_origin").notNull(),
	cacheBaseUrl: text("cache_base_url").notNull(),
	sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
	entryCount: bigint("entry_count", { mode: "number" }).default(0).notNull(),
	observedAt: timestamp("observed_at", { withTimezone: true, mode: 'string' }).notNull(),
	error: text(),
	activeSnapshotId: uuid("active_snapshot_id"),
	activeSnapshotStartedAt: timestamp("active_snapshot_started_at", { withTimezone: true, mode: 'string' }),
	lastCompletedSnapshotId: uuid("last_completed_snapshot_id"),
	runnerCacheEnabled: boolean("runner_cache_enabled"),
	runnerCacheMaxGiB: integer("runner_cache_max_gib"),
	runnerCacheSizeBytes: bigint("runner_cache_size_bytes", { mode: "number" }),
	runnerCacheEntryCount: bigint("runner_cache_entry_count", { mode: "number" }),
	runnerCacheObservedAt: timestamp("runner_cache_observed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({ columns: [table.workerId], foreignColumns: [workers.id], name: "worker_cache_status_worker_id_fkey" }).onDelete("cascade"),
	check("worker_cache_status_size_bytes_check", sql`size_bytes >= 0`),
	check("worker_cache_status_entry_count_check", sql`entry_count >= 0`),
	check("worker_cache_status_runner_size_bytes_check", sql`runner_cache_size_bytes IS NULL OR runner_cache_size_bytes >= 0`),
	check("worker_cache_status_runner_entry_count_check", sql`runner_cache_entry_count IS NULL OR runner_cache_entry_count >= 0`),
]);

export const workerCacheEntries = pgTable("worker_cache_entries", {
	workerId: uuid("worker_id").notNull(),
	entryId: uuid("entry_id").notNull(),
	githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
	cacheKeyPreview: text("cache_key_preview").notNull(),
	cacheKeyHash: text("cache_key_hash").notNull(),
	scopePreview: text("scope_preview").notNull(),
	scopeHash: text("scope_hash").notNull(),
	versionHash: text("version_hash").notNull(),
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	observedGeneration: uuid("observed_generation").notNull(),
}, (table) => [
	primaryKey({ columns: [table.workerId, table.entryId], name: "worker_cache_entries_pkey" }),
	foreignKey({ columns: [table.workerId], foreignColumns: [workers.id], name: "worker_cache_entries_worker_id_fkey" }).onDelete("cascade"),
	index("worker_cache_entries_order_idx").on(table.workerId, table.lastAccessedAt, table.entryId),
	index("worker_cache_entries_repository_idx").on(table.workerId, table.githubRepositoryId),
]);

export const workerCacheSnapshotEntries = pgTable("worker_cache_snapshot_entries", {
	workerId: uuid("worker_id").notNull(),
	snapshotId: uuid("snapshot_id").notNull(),
	sequence: integer().notNull(),
	entryId: uuid("entry_id").notNull(),
	githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
	cacheKeyPreview: text("cache_key_preview").notNull(),
	cacheKeyHash: text("cache_key_hash").notNull(),
	scopePreview: text("scope_preview").notNull(),
	scopeHash: text("scope_hash").notNull(),
	versionHash: text("version_hash").notNull(),
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	observedGeneration: uuid("observed_generation").notNull(),
	stagedAt: timestamp("staged_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.workerId, table.snapshotId, table.sequence, table.entryId], name: "worker_cache_snapshot_entries_pkey" }),
	foreignKey({ columns: [table.workerId], foreignColumns: [workers.id], name: "worker_cache_snapshot_entries_worker_id_fkey" }).onDelete("cascade"),
	index("worker_cache_snapshot_entries_idx").on(table.workerId, table.snapshotId, table.sequence, table.entryId),
	index("worker_cache_snapshot_entries_staged_at_idx").on(table.stagedAt),
]);
