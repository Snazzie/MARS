import type { DatabaseClient } from "./index.ts";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  OnboardingDetail,
  OnboardingStatus,
  type OnboardingInstallation,
  type OnboardingVerification,
  type OnboardingWorker,
  type OrganizationSummary,
  type PoolSummary,
  type RepositorySummary,
} from "@mars/contracts";

export type OnboardingDb = DatabaseClient;
type Row = Record<string, unknown>;

const first = (rows: readonly unknown[]): Row | undefined => rows[0] && typeof rows[0] === "object" ? rows[0] as Row : undefined;
const stringValue = (value: unknown): string | null => typeof value === "string" ? value : value instanceof Date ? value.toISOString() : null;
const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nullableObjectValue = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const numberValue = (value: unknown): number => typeof value === "number" ? value : Number(value ?? 0);

const queries = defineQueries((db) => ({
  status: db.select({
    adminUserId: schema.systemOnboarding.adminUserId,
    workerId: schema.systemOnboarding.workerId,
    organizationId: schema.systemOnboarding.organizationId,
    completedAt: schema.systemOnboarding.completedAt,
    workerAdmissionState: schema.workers.admissionState,
    workerConfigurationState: schema.workers.configurationState,
    publicBaseUrl: sql<string | null>`(SELECT ${schema.controlPlaneConfig.publicBaseUrl} FROM ${schema.controlPlaneConfig} WHERE ${schema.controlPlaneConfig.singleton}=true)`,
    originConfigured: sql<boolean>`EXISTS (SELECT 1 FROM ${schema.controlPlaneConfig} WHERE ${schema.controlPlaneConfig.singleton}=true AND ${schema.controlPlaneConfig.publicBaseUrl} IS NOT NULL)`,
    githubAppConfigured: sql<boolean>`EXISTS (SELECT 1 FROM ${schema.githubAppConfig} WHERE ${schema.githubAppConfig.singleton}=true AND ${schema.githubAppConfig.clientId} IS NOT NULL)`,
    githubReady: sql<boolean>`EXISTS (SELECT 1 FROM ${schema.dashboardInstallations} i JOIN ${schema.dashboardRepositories} r ON r.installation_id=i.id AND r.organization_id=i.organization_id WHERE i.organization_id=${schema.systemOnboarding.organizationId} AND i.state='approved' AND i.repository_selection IN ('all','selected') AND r.available=true)`,
  }).from(schema.systemOnboarding).leftJoin(schema.workers, eq(schema.workers.id, schema.systemOnboarding.workerId)).where(eq(schema.systemOnboarding.singleton, true)).prepare("onboarding_status"),
  selectedWorker: db.select({
    id: schema.workers.id, name: schema.workers.name, platform: schema.workers.platform, releaseVersion: schema.workers.releaseVersion,
    contractVersion: schema.workers.contractVersion, guestPlatforms: schema.workers.guestPlatforms, admissionState: schema.workers.admissionState,
    connectionState: schema.workers.connectionState, configurationState: schema.workers.configurationState, desiredConfiguration: schema.workers.desiredConfiguration,
    publicKey: schema.workers.publicKey, fingerprint: schema.workers.fingerprint, vmUuid: schema.workers.vmUuid,
    machineUuid: schema.workers.machineUuid, doctor: schema.workers.doctor, limits: schema.workers.limits,
    doctorObservedAt: schema.workers.doctorObservedAt, configurationRevision: schema.workers.configurationRevision,
    appliedConfigurationRevision: schema.workers.appliedConfigurationRevision,
  }).from(schema.workers).innerJoin(schema.systemOnboarding, eq(schema.systemOnboarding.workerId, schema.workers.id)).where(eq(schema.systemOnboarding.singleton, true)).prepare("onboarding_selected_worker"),
  organizations: db.select({
    id: schema.organizations.id, name: schema.organizations.login, login: schema.organizations.login, role: schema.memberships.role,
    repositoryCount: sql<number>`(SELECT count(*)::int FROM ${schema.dashboardRepositories} WHERE ${schema.dashboardRepositories.organizationId}=${schema.organizations.id})`,
    workerCount: sql<number>`(SELECT count(DISTINCT ${schema.runnerPools.workerId})::int FROM ${schema.runnerPools} WHERE ${schema.runnerPools.organizationId}=${schema.organizations.id})`,
  }).from(schema.organizations).innerJoin(schema.memberships, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(eq(schema.memberships.userId, sql`(SELECT ${schema.systemOnboarding.adminUserId} FROM ${schema.systemOnboarding} WHERE ${schema.systemOnboarding.singleton}=true)`)).orderBy(asc(schema.organizations.login)).prepare("onboarding_organizations"),
  state: db.select({
    organizationId: schema.systemOnboarding.organizationId, verificationRepositoryId: schema.systemOnboarding.verificationRepositoryId,
    verificationPoolId: schema.systemOnboarding.verificationPoolId, verificationWorkflowPath: schema.systemOnboarding.verificationWorkflowPath,
    verificationGithubRunId: schema.systemOnboarding.verificationGithubRunId, verificationError: schema.systemOnboarding.verificationError,
  }).from(schema.systemOnboarding).where(eq(schema.systemOnboarding.singleton, true)).prepare("onboarding_state"),
  installation: db.select({ id: schema.dashboardInstallations.id, githubInstallationId: schema.dashboardInstallations.githubInstallationId, state: schema.dashboardInstallations.state, repositorySelection: schema.dashboardInstallations.repositorySelection })
    .from(schema.dashboardInstallations).where(eq(schema.dashboardInstallations.organizationId, sql.placeholder("organizationId"))).orderBy(desc(schema.dashboardInstallations.createdAt)).limit(1).prepare("onboarding_installation"),
  repositories: db.select({
    id: schema.dashboardRepositories.id, organizationId: schema.dashboardRepositories.organizationId, name: schema.dashboardRepositories.name,
    fullName: schema.dashboardRepositories.fullName, visibility: schema.dashboardRepositories.visibility, available: schema.dashboardRepositories.available,
    installationId: schema.dashboardRepositories.installationId, discoveryError: schema.dashboardRepositories.discoveryError, discoveryRetryAt: schema.dashboardRepositories.discoveryRetryAt,
  }).from(schema.dashboardRepositories).where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.installationId, sql.placeholder("installationId")))).orderBy(asc(schema.dashboardRepositories.fullName)).prepare("onboarding_repositories"),
  pools: db.select({
    id: schema.runnerPools.id, organizationId: schema.runnerPools.organizationId, workerId: schema.runnerPools.workerId,
    workerName: sql<string>`'Shared fleet'`, name: schema.runnerPools.name, platform: schema.runnerPools.platform, driver: schema.runnerPools.driver,
    imageDigest: schema.runnerPools.imageDigest, resources: schema.runnerPools.resources, cpuMode: schema.runnerPools.cpuMode,
    labels: schema.runnerPools.labels, triggerLabel: schema.runnerPools.triggerLabel, enabled: schema.runnerPools.enabled,
    active: sql<number>`(${db.select({ count: sql<number>`count(*)::int` }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.poolId, schema.runnerPools.id), sql`${schema.runnerLeases.state} NOT IN ('completed','reaped','failed')`))})`,
  }).from(schema.runnerPools).where(and(isNull(schema.runnerPools.organizationId), eq(schema.runnerPools.enabled, true))).orderBy(asc(schema.runnerPools.name), asc(schema.runnerPools.id)).prepare("onboarding_pools"),
  verificationRun: db.select({
    id: schema.dashboardRuns.id, status: schema.dashboardRuns.status, conclusion: schema.dashboardRuns.conclusion,
    leaseReaped: sql<boolean>`EXISTS (${db.select({ id: schema.dashboardJobs.id }).from(schema.dashboardJobs).innerJoin(schema.runnerLeases, eq(schema.runnerLeases.githubJobId, schema.dashboardJobs.githubJobId)).where(and(eq(schema.dashboardJobs.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardJobs.runId, schema.dashboardRuns.id), eq(schema.runnerLeases.poolId, sql.placeholder("poolId")), eq(schema.runnerLeases.state, "reaped")))})`,
  }).from(schema.dashboardRuns).where(and(eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.githubRunId, sql.placeholder("githubRunId")))).limit(1).prepare("onboarding_verification_run"),
  appConfigured: db.select({ configured: schema.githubAppConfig.singleton }).from(schema.githubAppConfig).where(eq(schema.githubAppConfig.singleton, true)).prepare("onboarding_app_configured"),
  selectableWorker: db.select({ id: schema.workers.id }).from(schema.workers).where(and(eq(schema.workers.id, sql.placeholder("workerId")), inArray(schema.workers.admissionState, ["pending", "adopted"]))).prepare("onboarding_selectable_worker"),
  selectWorker: db.insert(schema.systemOnboarding).values({ singleton: true, adminUserId: sql.placeholder("adminUserId"), workerId: sql.placeholder("workerId") }).onConflictDoUpdate({ target: schema.systemOnboarding.singleton, set: { adminUserId: sql`${sql.placeholder("adminUserId")}`, workerId: sql`${sql.placeholder("workerId")}` } }).prepare("onboarding_select_worker"),
  repositoryOrganization: db.select({ organizationId: schema.systemOnboarding.organizationId }).from(schema.systemOnboarding).where(and(eq(schema.systemOnboarding.singleton, true), eq(schema.systemOnboarding.adminUserId, sql.placeholder("adminUserId")))).prepare("onboarding_repository_organization"),
  verifiedRepositories: db.select({ organizationId: schema.systemOnboarding.organizationId, repositoryCount: sql<number>`count(DISTINCT ${schema.dashboardRepositories.id})::int` })
    .from(schema.systemOnboarding).innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.organizationId, schema.systemOnboarding.organizationId), eq(schema.dashboardInstallations.state, "approved"), inArray(schema.dashboardInstallations.repositorySelection, ["all", "selected"])))
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.installationId, schema.dashboardInstallations.id), eq(schema.dashboardRepositories.organizationId, schema.dashboardInstallations.organizationId), eq(schema.dashboardRepositories.available, true)))
    .where(and(eq(schema.systemOnboarding.singleton, true), eq(schema.systemOnboarding.adminUserId, sql.placeholder("adminUserId")))).groupBy(schema.systemOnboarding.organizationId).prepare("onboarding_verified_repositories"),
  recordVerification: db.update(schema.systemOnboarding).set({
    verificationRepositoryId: sql`${sql.placeholder("repositoryId")}`, verificationPoolId: sql`${sql.placeholder("poolId")}`,
    verificationWorkflowPath: sql`${sql.placeholder("workflowPath")}`, verificationGithubRunId: sql`${sql.placeholder("githubRunId")}`,
    verificationStartedAt: sql`now()`, verificationError: sql`${sql.placeholder("error")}`,
  }).where(and(eq(schema.systemOnboarding.singleton, true), eq(schema.systemOnboarding.adminUserId, sql.placeholder("adminUserId")), isNull(schema.systemOnboarding.completedAt))).returning({ singleton: schema.systemOnboarding.singleton }).prepare("onboarding_record_verification"),
  completionState: db.select({
    completedAt: schema.systemOnboarding.completedAt, adminUserId: schema.systemOnboarding.adminUserId, workerId: schema.systemOnboarding.workerId,
    organizationId: schema.systemOnboarding.organizationId, verificationPoolId: schema.systemOnboarding.verificationPoolId,
    verificationGithubRunId: schema.systemOnboarding.verificationGithubRunId,
  }).from(schema.systemOnboarding).where(eq(schema.systemOnboarding.singleton, true)).prepare("onboarding_completion_state"),
  skipVerificationReady: db.select({ ready: sql<number>`1` }).from(schema.workers).where(and(
    eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.admissionState, "adopted"), eq(schema.workers.configurationState, "ready"),
    eq(schema.workers.configurationRevision, schema.workers.appliedConfigurationRevision), sql`${schema.workers.doctorObservedAt}>now()-interval '60 seconds'`,
    sql`EXISTS (SELECT 1 FROM ${schema.runnerPools} p CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(${schema.workers.doctor}->'doctor')='object' THEN ${schema.workers.doctor}->'doctor' ELSE ${schema.workers.doctor} END AS evidence) e WHERE p.organization_id IS NULL AND p.enabled=true AND p.platform=ANY(SELECT jsonb_array_elements_text(${schema.workers.guestPlatforms})) AND p.driver=${schema.workers.desiredConfiguration}->>'selectedDriver' AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.evidence->'capabilities')='array' THEN e.evidence->'capabilities' ELSE '[]'::jsonb END) capability WHERE capability->>'driver'=p.driver AND capability->>'guestPlatform'=p.platform AND capability->>'ready'='true'))`,
  )).prepare("onboarding_skip_verification_ready"),
  verifiedReady: db.select({ ready: sql<number>`1` }).from(schema.workers).innerJoin(schema.dashboardRuns, and(
    eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.githubRunId, sql.placeholder("githubRunId")),
    eq(schema.dashboardRuns.status, "completed"), eq(schema.dashboardRuns.conclusion, "success"),
  )).where(and(
    eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.admissionState, "adopted"), eq(schema.workers.configurationState, "ready"),
    eq(schema.workers.configurationRevision, schema.workers.appliedConfigurationRevision), sql`${schema.workers.doctorObservedAt}>now()-interval '60 seconds'`,
    sql`EXISTS (SELECT 1 FROM ${schema.dashboardJobs} j JOIN ${schema.runnerLeases} l ON l.github_job_id=j.github_job_id JOIN ${schema.runnerPools} p ON p.id=l.pool_id WHERE j.organization_id=${schema.dashboardRuns.organizationId} AND j.run_id=${schema.dashboardRuns.id} AND l.pool_id=${sql.placeholder("poolId")} AND l.state='reaped' AND p.driver=${schema.workers.desiredConfiguration}->>'selectedDriver' AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${schema.workers.doctor}->'doctor'->'capabilities')='array' THEN ${schema.workers.doctor}->'doctor'->'capabilities' ELSE '[]'::jsonb END) capability WHERE capability->>'driver'=p.driver AND capability->>'guestPlatform'=p.platform AND capability->>'ready'='true'))`,
  )).prepare("onboarding_verified_ready"),
  complete: db.update(schema.systemOnboarding).set({ completedAt: sql`now()` }).where(and(eq(schema.systemOnboarding.singleton, true), isNull(schema.systemOnboarding.completedAt))).returning({ completedAt: schema.systemOnboarding.completedAt }).prepare("onboarding_complete"),
}));

function statusFromRow(row: Row | undefined, auth: OnboardingAuth, setup: OnboardingSetup): OnboardingStatus {
  const adminUserId = stringValue(row?.adminUserId);
  const workerId = stringValue(row?.workerId);
  const organizationId = stringValue(row?.organizationId);
  const completed = row?.completedAt != null;
  const admission = stringValue(row?.workerAdmissionState);
  const configuration = stringValue(row?.workerConfigurationState);
  const originConfigured = row?.originConfigured === true;
  const githubAppConfigured = row?.githubAppConfigured === true;
  const githubReady = row?.githubReady === true;
  const authenticated = auth.authenticated ?? false;
  const canManage = auth.canManage ?? false;
  const base = { version: 1 as const, publicBaseUrl: stringValue(row?.publicBaseUrl), publicBaseUrlManaged: setup.publicBaseUrlManaged, authenticated, canManage, adminCreated: Boolean(adminUserId) };
  if (completed) return { ...base, onboardingRequired: false, step: "complete" };
  if (!originConfigured || !githubAppConfigured) return { ...base, onboardingRequired: true, step: "setup" };
  let step: OnboardingStatus["step"] = "admin";
  if (adminUserId) {
    if (!workerId || admission !== "adopted" || configuration !== "ready") step = "worker";
    else if (!organizationId || !githubReady) step = "github";
    else step = "labels";
  }
  return { ...base, onboardingRequired: true, step };
}
type OnboardingAuth = { authenticated?: boolean; canManage?: boolean };
type OnboardingSetup = { publicBaseUrlManaged: boolean };

export async function getOnboardingStatus(db: OnboardingDb, auth: OnboardingAuth = {}, setup: OnboardingSetup = { publicBaseUrlManaged: false }): Promise<OnboardingStatus> {
  return statusFromRow(first(await queries(db).status.execute()), auth, setup);
}

export async function getOnboardingDetail(
  db: OnboardingDb,
  auth: OnboardingAuth = {},
  extras: Partial<Pick<OnboardingDetail, "defaultImageDigests">> = {},
  setup: OnboardingSetup = { publicBaseUrlManaged: false },
): Promise<OnboardingDetail> {
  const status = await getOnboardingStatus(db, auth, setup);
  const selectedRow = first(await queries(db).selectedWorker.execute());
  let worker: OnboardingWorker | null = null;
  if (selectedRow) {
    const rawTelemetry = objectValue(selectedRow.doctor);
    const telemetry = "doctor" in rawTelemetry || "capacity" in rawTelemetry ? rawTelemetry : { doctor: rawTelemetry, capacity: {} };
    const rawCapacity = telemetry.capacity && typeof telemetry.capacity === "object" && !Array.isArray(telemetry.capacity) ? telemetry.capacity as Record<string, unknown> : {};
    const capacity = { actualVcpu: 0, actualMemoryBytes: 0, actualStorageBytes: 0, freeVcpu: 0, freeMemoryBytes: 0, freeStorageBytes: 0, ...rawCapacity };
    worker = {
      id: String(selectedRow.id), name: String(selectedRow.name), platform: selectedRow.platform as OnboardingWorker["platform"],
      guestPlatforms: Array.isArray(selectedRow.guestPlatforms) ? selectedRow.guestPlatforms as OnboardingWorker["guestPlatforms"] : [selectedRow.platform as OnboardingWorker["platform"]],
      releaseVersion: typeof selectedRow.releaseVersion === "string" ? selectedRow.releaseVersion : null,
      contractVersion: typeof selectedRow.contractVersion === "string" ? selectedRow.contractVersion : null,
      admissionState: selectedRow.admissionState as OnboardingWorker["admissionState"], connectionState: selectedRow.connectionState as OnboardingWorker["connectionState"], configurationState: selectedRow.configurationState as OnboardingWorker["configurationState"],
      publicKey: String(selectedRow.publicKey ?? ""), fingerprint: String(selectedRow.fingerprint ?? ""), vmUuid: String(selectedRow.vmUuid ?? ""), machineUuid: String(selectedRow.machineUuid ?? ""),
      doctor: objectValue(telemetry.doctor) as OnboardingWorker["doctor"], capacity: capacity as OnboardingWorker["capacity"], limits: nullableObjectValue(selectedRow.limits) as OnboardingWorker["limits"], configurationRevision: stringValue(selectedRow.configurationRevision),
    };
  }
  const organizationRows = await queries(db).organizations.execute();
  const organizations: OrganizationSummary[] = organizationRows.map((row) => ({ id: String(row.id), name: String(row.name), login: String(row.login), role: row.role as OrganizationSummary["role"], repositoryCount: numberValue(row.repositoryCount), workerCount: numberValue(row.workerCount) }));
  const stateRow = first(await queries(db).state.execute());
  const organizationId = stringValue(stateRow?.organizationId);
  const installationRow = organizationId ? first(await queries(db).installation.execute({ organizationId })) : undefined;
  const installation: OnboardingInstallation | null = installationRow ? { id: String(installationRow.id), githubInstallationId: numberValue(installationRow.githubInstallationId), state: installationRow.state as OnboardingInstallation["state"], repositorySelection: installationRow.repositorySelection as OnboardingInstallation["repositorySelection"] } : null;
  const repositoryRows = organizationId && installation ? await queries(db).repositories.execute({ organizationId, installationId: installation.id }) : [];
  const repositories = repositoryRows.map((row) => {
    const discoveryRetryAt = stringValue(row.discoveryRetryAt);
    const discoveryState = row.discoveryError === "github_403" ? discoveryRetryAt && Date.parse(discoveryRetryAt) > Date.now() ? "paused" : "queued" : row.discoveryError === "github_rate_limited" ? discoveryRetryAt && Date.parse(discoveryRetryAt) > Date.now() ? "rate_limited" : "queued" : "active";
    return { id: String(row.id), organizationId: String(row.organizationId), name: String(row.name), fullName: String(row.fullName), visibility: row.visibility, available: row.available, installationId: String(row.installationId), discoveryState, discoveryRetryAt } as RepositorySummary;
  });
  const desired = typeof selectedRow?.desiredConfiguration === "string" ? JSON.parse(selectedRow.desiredConfiguration) : selectedRow?.desiredConfiguration;
  const configReady = selectedRow?.configurationState === "ready" && selectedRow.configurationRevision === selectedRow.appliedConfigurationRevision && selectedRow.doctorObservedAt != null && Date.now() - new Date(String(selectedRow.doctorObservedAt)).getTime() < 60_000;
  const workerDriver = configReady ? desired?.selectedDriver : undefined;
  const workerDoctor = objectValue(selectedRow?.doctor);
  const doctor = workerDoctor.doctor && typeof workerDoctor.doctor === "object" ? workerDoctor.doctor as Record<string, unknown> : workerDoctor;
  const workerGuestPlatforms = worker?.guestPlatforms ?? (worker ? [worker.platform] : []);
  const poolRows = worker ? await queries(db).pools.execute() : [];
  const poolRow = poolRows.find((candidate) => candidate.driver === workerDriver && workerGuestPlatforms.includes(candidate.platform as OnboardingWorker["platform"]) && Array.isArray(doctor.capabilities) && doctor.capabilities.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).driver === candidate.driver && (item as Record<string, unknown>).guestPlatform === candidate.platform && (item as Record<string, unknown>).ready === true));
  const pool = poolRow ? { id: String(poolRow.id), organizationId: poolRow.organizationId == null ? null : String(poolRow.organizationId), workerId: poolRow.workerId == null ? null : String(poolRow.workerId), workerName: String(poolRow.workerName), name: String(poolRow.name), platform: poolRow.platform, driver: poolRow.driver, imageDigest: String(poolRow.imageDigest), resources: objectValue(poolRow.resources), cpuMode: poolRow.cpuMode === "exclusive" ? "exclusive" : "shared", labels: Array.isArray(poolRow.labels) ? poolRow.labels : (() => { try { return JSON.parse(String(poolRow.labels)); } catch { return []; } })(), triggerLabel: poolRow.triggerLabel, enabled: poolRow.enabled, active: numberValue(poolRow.active) } as PoolSummary : null;
  const verificationGithubRunId = stateRow?.verificationGithubRunId == null ? null : numberValue(stateRow.verificationGithubRunId);
  const verificationRun = organizationId && verificationGithubRunId ? first(await queries(db).verificationRun.execute({ organizationId, githubRunId: verificationGithubRunId, poolId: stringValue(stateRow?.verificationPoolId) })) : undefined;
  let verificationState: OnboardingVerification["state"] = "not_started";
  let verificationError = stringValue(stateRow?.verificationError);
  if (verificationGithubRunId) {
    if (!verificationRun || verificationRun.status === "queued") verificationState = "queued";
    else if (verificationRun.status === "in_progress") verificationState = "running";
    else if (verificationRun.conclusion === "success" && verificationRun.leaseReaped === true) verificationState = "complete";
    else if (verificationRun.conclusion === "success") verificationState = "reaping";
    else { verificationState = "failed"; verificationError = `Workflow completed with ${stringValue(verificationRun.conclusion) ?? "an unknown result"}`; }
  } else if (verificationError) verificationState = "failed";
  const verification: OnboardingVerification = { state: verificationState, repositoryId: stringValue(stateRow?.verificationRepositoryId), poolId: stringValue(stateRow?.verificationPoolId), workflowPath: stringValue(stateRow?.verificationWorkflowPath), githubRunId: verificationGithubRunId, runId: stringValue(verificationRun?.id), error: verificationError };
  const appConfigured = (await queries(db).appConfigured.execute()).length > 0;
  return OnboardingDetail.parse({ ...status, worker, organizations, github: { appConfigured, organizationId, installation, repositories }, pool, verification, defaultImageDigests: extras.defaultImageDigests ?? {} });
}

export async function selectOnboardingWorker(db: OnboardingDb, workerId: string, adminUserId: string): Promise<void> {
  if (!first(await queries(db).selectableWorker.execute({ workerId }))) throw new Error("worker_not_selectable");
  await queries(db).selectWorker.execute({ adminUserId, workerId });
}
export async function getOnboardingRepositoryOrganization(db: OnboardingDb, adminUserId: string): Promise<string | null> {
  return stringValue(first(await queries(db).repositoryOrganization.execute({ adminUserId }))?.organizationId);
}
export async function getVerifiedOnboardingRepositories(db: OnboardingDb, adminUserId: string): Promise<{ organizationId: string; repositoryCount: number } | null> {
  const row = first(await queries(db).verifiedRepositories.execute({ adminUserId }));
  const organizationId = stringValue(row?.organizationId);
  const repositoryCount = numberValue(row?.repositoryCount);
  return organizationId && repositoryCount > 0 ? { organizationId, repositoryCount } : null;
}
export async function recordOnboardingVerification(db: OnboardingDb, adminUserId: string, input: { repositoryId: string; poolId: string; workflowPath: string; githubRunId?: number; error?: string }): Promise<boolean> {
  const rows = await queries(db).recordVerification.execute({ repositoryId: input.repositoryId, poolId: input.poolId, workflowPath: input.workflowPath, githubRunId: input.githubRunId ?? null, error: input.error ?? null, adminUserId });
  return rows.length === 1;
}
export async function completeOnboardingIfReady(db: OnboardingDb, options: { skipVerification?: boolean } = {}): Promise<boolean> {
  const row = first(await queries(db).completionState.execute());
  if (!row || row.completedAt != null || !row.adminUserId || !row.workerId || !row.organizationId) return false;
  if (!options.skipVerification && (!row.verificationPoolId || !row.verificationGithubRunId)) return false;
  const ready = options.skipVerification
    ? await queries(db).skipVerificationReady.execute({ workerId: String(row.workerId) })
    : await queries(db).verifiedReady.execute({ workerId: String(row.workerId), organizationId: String(row.organizationId), githubRunId: numberValue(row.verificationGithubRunId), poolId: String(row.verificationPoolId) });
  if (!ready.length) return false;
  return (await queries(db).complete.execute()).length === 1;
}
