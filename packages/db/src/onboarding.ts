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
const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
          AND i.repository_selection='selected'
          AND r.available=true AND r.approved=true
          AND r.visibility IN ('private','internal')
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
    if (!workerId || !["pending", "adopted"].includes(admission ?? "")) step = "worker";
    else if (!organizationId || !githubReady) step = "github";
    else if (admission !== "adopted" || configuration !== "ready") step = "resources";
    else step = "labels";
  }
  return { version: 1, onboardingRequired: true, adminCreated: Boolean(adminUserId), authenticated, canManage, step };
}

export async function getOnboardingDetail(
  db: OnboardingDb,
  auth: { authenticated?: boolean; canManage?: boolean } = {},
  extras: Partial<Pick<OnboardingDetail, "defaultImageDigest">> = {},
): Promise<OnboardingDetail> {
  const status = await getOnboardingStatus(db, auth);
  const selectedRow = first(await db`
    SELECT w.id,w.name,w.platform,w.admission_state AS "admissionState",
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
      admissionState: selectedRow.admissionState as OnboardingWorker["admissionState"],
      connectionState: selectedRow.connectionState as OnboardingWorker["connectionState"],
      configurationState: selectedRow.configurationState as OnboardingWorker["configurationState"],
      publicKey: String(selectedRow.publicKey ?? ""), fingerprint: String(selectedRow.fingerprint ?? ""),
      vmUuid: String(selectedRow.vmUuid ?? ""), machineUuid: String(selectedRow.machineUuid ?? ""),
      doctor: objectValue(telemetry.doctor) as OnboardingWorker["doctor"],
      capacity: objectValue(telemetry.capacity) as OnboardingWorker["capacity"],
      limits: selectedRow.limits as OnboardingWorker["limits"],
      configurationRevision: stringValue(selectedRow.configurationRevision),
    };
  }
  const organizationRows = await db`
    SELECT o.id,o.login AS name,o.login,m.role,
      (SELECT count(*)::int FROM dashboard_repositories r WHERE r.organization_id=o.id) AS "repositoryCount",
      (SELECT count(*)::int FROM workers w WHERE w.organization_id=o.id) AS "workerCount"
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
    SELECT id,organization_id AS "organizationId",name,full_name AS "fullName",visibility,available,approved,installation_id AS "installationId"
    FROM dashboard_repositories WHERE organization_id=${organizationId} AND installation_id=${installation.id}
    ORDER BY full_name
  ` : [];
  const repositories = repositoryRows.map((row) => ({
    id: String(row.id), organizationId: String(row.organizationId), name: String(row.name), fullName: String(row.fullName),
    visibility: row.visibility, available: row.available, approved: row.approved, installationId: String(row.installationId),
  })) as RepositorySummary[];
  const poolRow = worker ? first(await db`
    SELECT p.id,p.organization_id AS "organizationId",p.worker_id AS "workerId",w.name AS "workerName",
      p.name,p.platform,p.driver,p.image_digest AS "imageDigest",p.resources,p.labels,p.trigger_label AS "triggerLabel",
      p.enabled,(SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.state NOT IN ('completed','reaped','failed')) AS active
    FROM runner_pools p JOIN workers w ON w.id=p.worker_id
    WHERE p.worker_id=${worker.id} ORDER BY p.enabled DESC,p.id LIMIT 1
  `) : undefined;
  const pool = poolRow ? {
    id: String(poolRow.id), organizationId: String(poolRow.organizationId), workerId: String(poolRow.workerId), workerName: String(poolRow.workerName),
    name: String(poolRow.name), platform: poolRow.platform, driver: poolRow.driver, imageDigest: String(poolRow.imageDigest),
    resources: poolRow.resources, labels: poolRow.labels, triggerLabel: poolRow.triggerLabel, enabled: poolRow.enabled, active: numberValue(poolRow.active),
  } as PoolSummary : null;
  const appConfigured = (await db`SELECT 1 FROM github_app_config WHERE singleton=true`).length > 0;
  return OnboardingDetail.parse({ ...status, worker, organizations, github: { appConfigured, organizationId, installation, repositories }, pool, defaultImageDigest: extras.defaultImageDigest ?? null });
}

export async function selectOnboardingWorker(db: OnboardingDb, workerId: string, adminUserId: string): Promise<void> {
  const worker = first(await db`SELECT id FROM workers WHERE id=${workerId} AND admission_state IN ('pending','adopted')`);
  if (!worker) throw new Error("worker_not_selectable");
  await db`INSERT INTO system_onboarding(singleton,admin_user_id,worker_id) VALUES(true,${adminUserId},${workerId}) ON CONFLICT(singleton) DO UPDATE SET admin_user_id=EXCLUDED.admin_user_id,worker_id=EXCLUDED.worker_id`;
}

export async function approveOnboardingRepositories(db: OnboardingDb, repositoryIds: string[], adminUserId: string): Promise<void> {
  await db.begin(async (tx) => {
    const rows = await tx`
      SELECT r.id,r.installation_id AS "installationId",r.visibility,r.available,i.state
      FROM dashboard_repositories r
      JOIN dashboard_installations i ON i.id=r.installation_id AND i.organization_id=r.organization_id
      JOIN system_onboarding so ON so.organization_id=r.organization_id
      WHERE so.singleton=true AND so.admin_user_id=${adminUserId} AND r.id=ANY(${repositoryIds})
      FOR UPDATE
    `;
    const installationIds = new Set(rows.map((row) => String(row.installationId)));
    if (rows.length !== repositoryIds.length || installationIds.size !== 1 || rows.some((row) => !["private", "internal"].includes(String(row.visibility)) || row.available !== true || row.state !== "approved")) {
      throw new Error("repositories_not_selectable");
    }
    await tx`UPDATE dashboard_repositories SET approved=(id=ANY(${repositoryIds})) WHERE installation_id=${String(rows[0].installationId)} AND visibility IN ('private','internal')`;
  });
}

export async function completeOnboardingIfReady(db: OnboardingDb): Promise<boolean> {
  const row = first(await db`SELECT completed_at AS "completedAt",admin_user_id AS "adminUserId",worker_id AS "workerId",organization_id AS "organizationId" FROM system_onboarding WHERE singleton=true`);
  if (!row || row.completedAt != null || !row.adminUserId || !row.workerId || !row.organizationId) return false;
  const ready = await db`
    SELECT 1 FROM workers w JOIN runner_pools p ON p.worker_id=w.id AND p.organization_id=w.organization_id
    WHERE w.id=${String(row.workerId)} AND w.admission_state='adopted' AND w.connection_state='online'
      AND w.configuration_state='ready' AND p.enabled=true AND p.trigger_label IS NOT NULL LIMIT 1
  `;
  if (!ready.length) return false;
  const updated = await db`UPDATE system_onboarding SET completed_at=now() WHERE singleton=true AND completed_at IS NULL RETURNING completed_at`;
  return updated.length === 1;
}
