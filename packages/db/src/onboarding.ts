import type { DatabaseClient } from "./index.ts";
import {
  OnboardingDetail,
  OnboardingStatus,
  type OnboardingInstallation,
  type OnboardingVerification,
  type OnboardingWorker,
  type OrganizationSummary,
  type PoolSummary,
  type RepositorySummary,
} from "@whitesmith/contracts";

export type OnboardingDb = DatabaseClient;
type Row = Record<string, unknown>;

const first = (rows: readonly unknown[]): Row | undefined => rows[0] && typeof rows[0] === "object" ? rows[0] as Row : undefined;
const stringValue = (value: unknown): string | null => typeof value === "string" ? value : value instanceof Date ? value.toISOString() : null;
const objectValue = (value: unknown): Record<string, unknown> => {
 const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return value; } })() : value;
 return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
};
const nullableObjectValue = (value: unknown): Record<string, unknown> | null => {
 if (value === null || value === undefined) return null;
 return objectValue(value);
};
const numberValue = (value: unknown): number => typeof value === "number" ? value : Number(value ?? 0);

export async function getOnboardingStatus(db: OnboardingDb, auth: { authenticated?: boolean; canManage?: boolean } = {}): Promise<OnboardingStatus> {
  const row = first(await db`
    SELECT so.admin_user_id AS "adminUserId", so.worker_id AS "workerId",
      so.organization_id AS "organizationId", so.completed_at AS "completedAt",
      w.admission_state AS "workerAdmissionState",
      w.configuration_state AS "workerConfigurationState",
      EXISTS (SELECT 1 FROM control_plane_config c WHERE c.singleton=true AND c.public_base_url IS NOT NULL) AS "originConfigured",
      EXISTS (SELECT 1 FROM github_app_config g WHERE g.singleton=true AND g.client_id IS NOT NULL) AS "githubAppConfigured",
      EXISTS (
        SELECT 1 FROM dashboard_installations i
        JOIN dashboard_repositories r ON r.installation_id=i.id AND r.organization_id=i.organization_id
        WHERE i.organization_id=so.organization_id
          AND i.state='approved'
          AND i.repository_selection IN ('all','selected')
          AND r.available=true
      ) AS "githubReady"
    FROM system_onboarding so
    LEFT JOIN workers w ON w.id=so.worker_id
    WHERE so.singleton=true
  `) ?? {};
  const adminUserId = stringValue(row.adminUserId);
  const workerId = stringValue(row.workerId);
  const organizationId = stringValue(row.organizationId);
  const completed = row.completedAt != null;
  const admission = stringValue(row.workerAdmissionState);
  const configuration = stringValue(row.workerConfigurationState);
  const originConfigured = row.originConfigured === true;
  const githubAppConfigured = row.githubAppConfigured === true;
  const githubReady = row.githubReady === true;
  const authenticated = auth.authenticated ?? false;
  const canManage = auth.canManage ?? false;
  if (completed) return { version: 1, onboardingRequired: false, adminCreated: Boolean(adminUserId), authenticated, canManage, step: "complete" };
  if (!originConfigured || !githubAppConfigured) return { version: 1, onboardingRequired: true, adminCreated: Boolean(adminUserId), authenticated, canManage, step: "setup" };
  let step: OnboardingStatus["step"] = "admin";
  if (adminUserId) {
    if (!workerId || admission !== "adopted" || configuration !== "ready") step = "worker";
    else if (!organizationId || !githubReady) step = "github";
    else step = "labels";
  }
  return { version: 1, onboardingRequired: true, adminCreated: Boolean(adminUserId), authenticated, canManage, step };
}

export async function getOnboardingDetail(
  db: OnboardingDb,
  auth: { authenticated?: boolean; canManage?: boolean } = {},
  extras: Partial<Pick<OnboardingDetail, "defaultImageDigests">> = {},
): Promise<OnboardingDetail> {
  const status = await getOnboardingStatus(db, auth);
  const selectedRow = first(await db`
    SELECT w.id,w.name,w.platform,w.guest_platforms AS "guestPlatforms",w.admission_state AS "admissionState",
      w.connection_state AS "connectionState",w.configuration_state AS "configurationState",
      w.public_key AS "publicKey",w.fingerprint,w.vm_uuid AS "vmUuid",
      w.machine_uuid AS "machineUuid",w.doctor,w.limits,
      w.configuration_revision AS "configurationRevision"
    FROM workers w JOIN system_onboarding so ON so.worker_id=w.id
    WHERE so.singleton=true
  `);
  let worker: OnboardingWorker | null = null;
  if (selectedRow) {
    const telemetry = objectValue(selectedRow.doctor);
    worker = {
      id: String(selectedRow.id), name: String(selectedRow.name), platform: selectedRow.platform as OnboardingWorker["platform"],
      guestPlatforms: Array.isArray(selectedRow.guestPlatforms) ? selectedRow.guestPlatforms as OnboardingWorker["guestPlatforms"] : [selectedRow.platform as OnboardingWorker["platform"]],
      admissionState: selectedRow.admissionState as OnboardingWorker["admissionState"],
      connectionState: selectedRow.connectionState as OnboardingWorker["connectionState"],
      configurationState: selectedRow.configurationState as OnboardingWorker["configurationState"],
      publicKey: String(selectedRow.publicKey ?? ""), fingerprint: String(selectedRow.fingerprint ?? ""),
      vmUuid: String(selectedRow.vmUuid ?? ""), machineUuid: String(selectedRow.machineUuid ?? ""),
      doctor: objectValue(telemetry.doctor) as OnboardingWorker["doctor"],
      capacity: objectValue(telemetry.capacity) as OnboardingWorker["capacity"],
      limits: nullableObjectValue(selectedRow.limits) as OnboardingWorker["limits"],
      configurationRevision: stringValue(selectedRow.configurationRevision),
    };
  }
  const organizationRows = await db`
    SELECT o.id,o.login AS name,o.login,m.role,
      (SELECT count(*)::int FROM dashboard_repositories r WHERE r.organization_id=o.id) AS "repositoryCount",
      (SELECT count(DISTINCT p.worker_id)::int FROM runner_pools p WHERE p.organization_id=o.id) AS "workerCount"
    FROM organizations o JOIN memberships m ON m.organization_id=o.id
    WHERE m.user_id=(SELECT admin_user_id FROM system_onboarding WHERE singleton=true)
    ORDER BY o.login
  `;
  const organizations: OrganizationSummary[] = organizationRows.map((row) => ({
    id: String(row.id), name: String(row.name), login: String(row.login),
    role: row.role as OrganizationSummary["role"], repositoryCount: numberValue(row.repositoryCount), workerCount: numberValue(row.workerCount),
  }));
  const stateRow = first(await db`SELECT organization_id AS "organizationId",
    verification_repository_id AS "verificationRepositoryId",verification_pool_id AS "verificationPoolId",
    verification_workflow_path AS "verificationWorkflowPath",verification_github_run_id AS "verificationGithubRunId",
    verification_error AS "verificationError"
    FROM system_onboarding WHERE singleton=true`);
  const organizationId = stringValue(stateRow?.organizationId);
  const installationRow = organizationId ? first(await db`
    SELECT id,github_installation_id AS "githubInstallationId",state,repository_selection AS "repositorySelection"
    FROM dashboard_installations WHERE organization_id=${organizationId}
    ORDER BY created_at DESC LIMIT 1
  `) : undefined;
  const installation: OnboardingInstallation | null = installationRow ? {
    id: String(installationRow.id), githubInstallationId: numberValue(installationRow.githubInstallationId),
    state: installationRow.state as OnboardingInstallation["state"],
    repositorySelection: installationRow.repositorySelection as OnboardingInstallation["repositorySelection"],
  } : null;
  const repositoryRows = organizationId && installation ? await db`
    SELECT id,organization_id AS "organizationId",name,full_name AS "fullName",visibility,available,installation_id AS "installationId",
      discovery_error AS "discoveryError",discovery_retry_at AS "discoveryRetryAt"
    FROM dashboard_repositories WHERE organization_id=${organizationId} AND installation_id=${installation.id}
    ORDER BY full_name
  ` : [];
  const repositories = repositoryRows.map((row) => {
    const discoveryRetryAt = stringValue(row.discoveryRetryAt);
    const discoveryState = row.discoveryError === "github_403"
      ? discoveryRetryAt && Date.parse(discoveryRetryAt) > Date.now() ? "paused" : "queued"
      : row.discoveryError === "github_rate_limited"
        ? discoveryRetryAt && Date.parse(discoveryRetryAt) > Date.now() ? "rate_limited" : "queued"
        : "active";
    return {
      id: String(row.id), organizationId: String(row.organizationId), name: String(row.name), fullName: String(row.fullName),
      visibility: row.visibility, available: row.available, installationId: String(row.installationId), discoveryState, discoveryRetryAt,
    } as RepositorySummary;
  });
  const workerDriver = worker?.platform === "linux-x64" ? "linux-libvirt-vm" : worker?.platform === "windows-x64" ? "windows-hyperv-container" : worker?.platform === "macos-arm64" ? "tart-vm" : null;
  const workerGuestPlatforms = worker?.guestPlatforms ?? (worker ? [worker.platform] : []);
  const poolRows = worker ? await db`
    SELECT p.id,p.organization_id AS "organizationId",p.worker_id AS "workerId",'Shared fleet' AS "workerName",
      p.name,p.platform,p.driver,p.image_digest AS "imageDigest",p.resources,p.labels,p.trigger_label AS "triggerLabel",
      p.enabled,(SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.state NOT IN ('completed','reaped','failed')) AS active
    FROM runner_pools p
    WHERE p.organization_id IS NULL AND p.enabled=true
    ORDER BY p.name,p.id
  ` : [];
  const poolRow = poolRows.find((candidate) => candidate.driver === workerDriver && workerGuestPlatforms.includes(candidate.platform as OnboardingWorker["platform"]));
  const pool = poolRow ? {
    id: String(poolRow.id), organizationId: poolRow.organizationId == null ? null : String(poolRow.organizationId), workerId: poolRow.workerId == null ? null : String(poolRow.workerId), workerName: String(poolRow.workerName),
    name: String(poolRow.name), platform: poolRow.platform, driver: poolRow.driver, imageDigest: String(poolRow.imageDigest),
    resources: objectValue(poolRow.resources), labels: Array.isArray(poolRow.labels) ? poolRow.labels : (() => { try { return JSON.parse(String(poolRow.labels)); } catch { return []; } })(), triggerLabel: poolRow.triggerLabel, enabled: poolRow.enabled, active: numberValue(poolRow.active),
  } as PoolSummary : null;
  const verificationGithubRunId = stateRow?.verificationGithubRunId == null ? null : numberValue(stateRow.verificationGithubRunId);
  const verificationRun = organizationId && verificationGithubRunId ? first(await db`
    SELECT r.id,r.status,r.conclusion,
      EXISTS (
        SELECT 1 FROM dashboard_jobs j
        JOIN runner_leases l ON l.github_job_id=j.github_job_id
        WHERE j.organization_id=r.organization_id AND j.run_id=r.id
          AND l.pool_id=${stringValue(stateRow?.verificationPoolId)} AND l.state='reaped'
      ) AS "leaseReaped"
    FROM dashboard_runs r
    WHERE r.organization_id=${organizationId} AND r.github_run_id=${verificationGithubRunId}
    LIMIT 1
  `) : undefined;
  let verificationState: OnboardingVerification["state"] = "not_started";
  let verificationError = stringValue(stateRow?.verificationError);
  if (verificationGithubRunId) {
    if (!verificationRun || verificationRun.status === "queued") verificationState = "queued";
    else if (verificationRun.status === "in_progress") verificationState = "running";
    else if (verificationRun.conclusion === "success" && verificationRun.leaseReaped === true) verificationState = "complete";
    else if (verificationRun.conclusion === "success") verificationState = "reaping";
    else {
      verificationState = "failed";
      verificationError = `Workflow completed with ${stringValue(verificationRun.conclusion) ?? "an unknown result"}`;
    }
  } else if (verificationError) {
    verificationState = "failed";
  }
  const verification: OnboardingVerification = {
    state: verificationState,
    repositoryId: stringValue(stateRow?.verificationRepositoryId),
    poolId: stringValue(stateRow?.verificationPoolId),
    workflowPath: stringValue(stateRow?.verificationWorkflowPath),
    githubRunId: verificationGithubRunId,
    runId: stringValue(verificationRun?.id),
    error: verificationError,
  };
  const appConfigured = (await db`SELECT 1 FROM github_app_config WHERE singleton=true`).length > 0;
  return OnboardingDetail.parse({ ...status, worker, organizations, github: { appConfigured, organizationId, installation, repositories }, pool, verification, defaultImageDigests: extras.defaultImageDigests ?? {} });
}

export async function selectOnboardingWorker(db: OnboardingDb, workerId: string, adminUserId: string): Promise<void> {
  const worker = first(await db`SELECT id FROM workers WHERE id=${workerId} AND admission_state IN ('pending','adopted')`);
  if (!worker) throw new Error("worker_not_selectable");
  await db`INSERT INTO system_onboarding(singleton,admin_user_id,worker_id) VALUES(true,${adminUserId},${workerId}) ON CONFLICT(singleton) DO UPDATE SET admin_user_id=EXCLUDED.admin_user_id,worker_id=EXCLUDED.worker_id`;
}
export async function getOnboardingRepositoryOrganization(db: OnboardingDb, adminUserId: string): Promise<string | null> {
  const row = first(await db`
    SELECT organization_id AS "organizationId"
    FROM system_onboarding
    WHERE singleton=true AND admin_user_id=${adminUserId}
  `);
  return stringValue(row?.organizationId);
}

export async function getVerifiedOnboardingRepositories(
  db: OnboardingDb,
  adminUserId: string,
): Promise<{ organizationId: string; repositoryCount: number } | null> {
  const row = first(await db`
    SELECT so.organization_id AS "organizationId",count(DISTINCT r.id)::int AS "repositoryCount"
    FROM system_onboarding so
    JOIN dashboard_installations i ON i.organization_id=so.organization_id
      AND i.state='approved' AND i.repository_selection IN ('all','selected')
    JOIN dashboard_repositories r ON r.installation_id=i.id
      AND r.organization_id=i.organization_id AND r.available=true
    WHERE so.singleton=true AND so.admin_user_id=${adminUserId}
    GROUP BY so.organization_id
  `);
  const organizationId = stringValue(row?.organizationId);
  const repositoryCount = numberValue(row?.repositoryCount);
  return organizationId && repositoryCount > 0 ? { organizationId, repositoryCount } : null;
}
export async function recordOnboardingVerification(
  db: OnboardingDb,
  adminUserId: string,
  input: { repositoryId: string; poolId: string; workflowPath: string; githubRunId?: number; error?: string },
): Promise<boolean> {
  const rows = await db`
    UPDATE system_onboarding SET
      verification_repository_id=${input.repositoryId},
      verification_pool_id=${input.poolId},
      verification_workflow_path=${input.workflowPath},
      verification_github_run_id=${input.githubRunId ?? null},
      verification_started_at=now(),
      verification_error=${input.error ?? null}
    WHERE singleton=true AND admin_user_id=${adminUserId} AND completed_at IS NULL
    RETURNING singleton
  `;
  return rows.length === 1;
}




export async function completeOnboardingIfReady(db: OnboardingDb): Promise<boolean> {
  const row = first(await db`SELECT completed_at AS "completedAt",admin_user_id AS "adminUserId",worker_id AS "workerId",organization_id AS "organizationId",verification_pool_id AS "verificationPoolId",verification_github_run_id AS "verificationGithubRunId" FROM system_onboarding WHERE singleton=true`);
  if (!row || row.completedAt != null || !row.adminUserId || !row.workerId || !row.organizationId || !row.verificationPoolId || !row.verificationGithubRunId) return false;
  const ready = await db`
    SELECT 1 FROM workers w
    JOIN dashboard_runs r ON r.organization_id=${String(row.organizationId)}
      AND r.github_run_id=${numberValue(row.verificationGithubRunId)}
      AND r.status='completed' AND r.conclusion='success'
    WHERE w.id=${String(row.workerId)} AND w.admission_state='adopted' AND w.configuration_state='ready'
      AND EXISTS (
        SELECT 1 FROM dashboard_jobs j
        JOIN runner_leases l ON l.github_job_id=j.github_job_id
        WHERE j.organization_id=r.organization_id AND j.run_id=r.id
          AND l.pool_id=${String(row.verificationPoolId)} AND l.state='reaped'
      )
    LIMIT 1
  `;
  if (!ready.length) return false;
  const updated = await db`UPDATE system_onboarding SET completed_at=now() WHERE singleton=true AND completed_at IS NULL RETURNING completed_at`;
  return updated.length === 1;
}
