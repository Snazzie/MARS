import type { Sql } from "postgres";
import {
  OnboardingDetail,
  OnboardingStatus,
  type OnboardingInstallation,
  type OnboardingWorker,
  type OrganizationSummary,
  type PoolSummary,
  type RepositorySummary,
} from "@whitesmith/contracts";

export type OnboardingDb = Sql<{}>;
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
      EXISTS (
        SELECT 1
        FROM dashboard_installations i
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
  const githubReady = row.githubReady === true;
  const authenticated = auth.authenticated ?? false;
  const canManage = auth.canManage ?? false;
  if (completed) return { version: 1, onboardingRequired: false, adminCreated: Boolean(adminUserId), authenticated, canManage, step: "complete" };
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
  const stateRow = first(await db`SELECT organization_id AS "organizationId" FROM system_onboarding WHERE singleton=true`);
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
      : "active";
    return {
      id: String(row.id), organizationId: String(row.organizationId), name: String(row.name), fullName: String(row.fullName),
      visibility: row.visibility, available: row.available, installationId: String(row.installationId), discoveryState, discoveryRetryAt,
    } as RepositorySummary;
  });
  const workerDriver = worker?.platform === "linux-x64" ? "kata-k3s" : worker?.platform === "windows-x64" ? "windows-hyperv-container" : worker?.platform === "macos-arm64" ? "tart-vm" : null;
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
  const appConfigured = (await db`SELECT 1 FROM github_app_config WHERE singleton=true`).length > 0;
  return OnboardingDetail.parse({ ...status, worker, organizations, github: { appConfigured, organizationId, installation, repositories }, pool, defaultImageDigests: extras.defaultImageDigests ?? {} });
}

export async function selectOnboardingWorker(db: OnboardingDb, workerId: string, adminUserId: string): Promise<void> {
  const worker = first(await db`SELECT id FROM workers WHERE id=${workerId} AND admission_state IN ('pending','adopted')`);
  if (!worker) throw new Error("worker_not_selectable");
  await db`INSERT INTO system_onboarding(singleton,admin_user_id,worker_id) VALUES(true,${adminUserId},${workerId}) ON CONFLICT(singleton) DO UPDATE SET admin_user_id=EXCLUDED.admin_user_id,worker_id=EXCLUDED.worker_id`;
}


export async function completeOnboardingIfReady(db: OnboardingDb): Promise<boolean> {
  const row = first(await db`SELECT completed_at AS "completedAt",admin_user_id AS "adminUserId",worker_id AS "workerId",organization_id AS "organizationId" FROM system_onboarding WHERE singleton=true`);
  if (!row || row.completedAt != null || !row.adminUserId || !row.workerId || !row.organizationId) return false;
  const ready = await db`
    SELECT 1 FROM workers w
    WHERE w.id=${String(row.workerId)} AND w.admission_state='adopted' AND w.connection_state='online' AND w.configuration_state='ready'
      AND EXISTS (
        SELECT 1 FROM runner_pools p
        WHERE p.organization_id IS NULL AND p.enabled=true AND p.trigger_label IS NOT NULL
          AND p.platform IN (SELECT jsonb_array_elements_text(w.guest_platforms))
          AND p.driver=CASE w.platform WHEN 'linux-x64' THEN 'kata-k3s' WHEN 'windows-x64' THEN 'windows-hyperv-container' ELSE 'tart-vm' END
      )
    LIMIT 1
  `;
  if (!ready.length) return false;
  const updated = await db`UPDATE system_onboarding SET completed_at=now() WHERE singleton=true AND completed_at IS NULL RETURNING completed_at`;
  return updated.length === 1;
}
