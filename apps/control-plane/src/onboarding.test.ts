import { describe, expect, test } from "bun:test";
import { createControlPlaneApp } from "./http/app.ts";
import { fakeHttpDeps } from "./http/test-deps.ts";
import { OnboardingStatus, OnboardingDetail, SelectOnboardingWorkerRequest } from "@mars/contracts";

describe("onboarding HTTP contract", () => {
  test("public status exposes only server-derived status fields", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/onboarding/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(OnboardingStatus.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty("worker");
    expect(body).not.toHaveProperty("privateKey");
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("webhookSecret");
  });

  test("detail and worker selection require an authenticated global administrator", async () => {
    const app = createControlPlaneApp(fakeHttpDeps());
    expect((await app.request("/api/onboarding")).status).toBe(401);
    const response = await app.request("/api/onboarding/worker", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "select-1" },
      body: JSON.stringify({ workerId: "00000000-0000-4000-8000-000000000001" } satisfies SelectOnboardingWorkerRequest),
    });
    expect(response.status).toBe(401);
  });
  test("repository verification remains blocked until an imported repository is available", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000002";
    let refreshes = 0;
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes('organization_id AS "organizationId"') && !query.includes("count(DISTINCT r.id)")) return [{ organizationId }];
      if (query.includes("count(DISTINCT r.id)")) return refreshes >= 2 ? [{ organizationId, repositoryCount: 1 }] : [];
      return [];
    }) as never;
    const app = createControlPlaneApp(fakeHttpDeps({
      db,
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { refreshInstallationRepositories: async () => { refreshes += 1; } } as never,
    }));
    const request = () => app.request("/api/onboarding/repositories/verify", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    const blocked = await request();
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "repository_selection_required" });
    const verified = await request();
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ ok: true, organizationId, repositoryCount: 1 });
  });
  test("dispatches a compatible workflow and returns its GitHub run identity", async () => {
    const workerId = "00000000-0000-4000-8000-000000000001";
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const poolId = "00000000-0000-4000-8000-000000000003";
    const repositoryId = "00000000-0000-4000-8000-000000000004";
    const installationId = "00000000-0000-4000-8000-000000000005";
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      const normalized = query.toLowerCase();
      if (query.includes('so.admin_user_id AS "adminUserId"')) return [{ adminUserId: "admin", workerId, organizationId, completedAt: null, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: true, verificationRepositoryId: null, verificationPoolId: null, verificationWorkflowPath: null, verificationGithubRunId: null, verificationStartedAt: null, verificationError: null }];
      if (query.includes("FROM workers w JOIN system_onboarding")) return [{ id: workerId, name: "windows-worker", platform: "windows-x64", guestPlatforms: ["windows-x64"], admissionState: "adopted", connectionState: "online", configurationState: "ready", publicKey: "public", fingerprint: "fingerprint", vmUuid: workerId, machineUuid: workerId, doctor: { doctor: {}, capacity: { actualVcpu: 4, actualMemoryBytes: 8_589_934_592, actualStorageBytes: 42_949_672_960, freeVcpu: 4, freeMemoryBytes: 8_589_934_592, freeStorageBytes: 42_949_672_960 } }, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_294_967_296, maxStorageBytesPerPod: 21_474_836_480, maxConcurrentPods: 1 }, configurationRevision: "a".repeat(64) }];
      if (query.includes("SELECT organization_id AS")) return [{ organizationId }];
      if (query.includes("FROM dashboard_installations WHERE")) return [{ id: installationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" }];
      if (query.includes("FROM dashboard_repositories WHERE")) return [{ id: repositoryId, organizationId, name: "private", fullName: "acme/private", visibility: "private", available: true, installationId, discoveryError: null, discoveryRetryAt: null }];
      if (query.includes("FROM runner_pools") && normalized.includes("p.organization_id is null")) return [{ id: poolId, organizationId: null, workerId: null, workerName: "Shared fleet", name: "default", platform: "windows-x64", driver: "windows-hyperv-container", imageDigest: `sha256:${"a".repeat(64)}`, resources: { vcpu: 2, memoryBytes: 2_147_483_648, storageBytes: 10_737_418_240, concurrency: 1 }, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64", enabled: true, active: 0 }];
      if (query.includes("INSERT INTO dashboard_mutations")) return [{ idempotency_key: "verify-1" }];
      return [];
    }) as never;
    const app = createControlPlaneApp(fakeHttpDeps({
      db,
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        listRepositoryRunnerWorkflows: async () => ({ defaultBranch: "main", files: [{ path: ".github/workflows/smoke.yml", sha: "sha", content: "on: workflow_dispatch\njobs:\n  smoke:\n    runs-on: mars-windows-x64\n" }] }),
        dispatchRepositoryWorkflow: async () => ({ githubRunId: 41 }),
      } as never,
    }));
    const response = await app.request("/api/onboarding/verification", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "verify-1" },
      body: JSON.stringify({ repositoryId, workflowPath: ".github/workflows/smoke.yml" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "queued", githubRunId: 41 });
  });


  test("uses the selected Windows worker template digest for pool creation", async () => {
    const workerId = "00000000-0000-4000-8000-000000000001";
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const installationId = "00000000-0000-4000-8000-000000000003";
    const templateDigest = `sha256:${"a".repeat(64)}`;
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes('so.admin_user_id AS "adminUserId"')) return [{ adminUserId: "admin", workerId, organizationId, completedAt: null, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: true }];
      if (query.includes("FROM workers w JOIN system_onboarding")) return [{ id: workerId, name: "windows-worker", platform: "windows-x64", guestPlatforms: ["windows-x64"], admissionState: "adopted", connectionState: "online", configurationState: "ready", publicKey: "public", fingerprint: "fingerprint", vmUuid: workerId, machineUuid: workerId, doctor: { doctor: {}, capacity: { actualVcpu: 4, actualMemoryBytes: 8_589_934_592, actualStorageBytes: 42_949_672_960, freeVcpu: 4, freeMemoryBytes: 8_589_934_592, freeStorageBytes: 42_949_672_960 } }, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_294_967_296, maxStorageBytesPerPod: 21_474_836_480, maxConcurrentPods: 1 }, configurationRevision: "a".repeat(64) }];
      if (query.includes("SELECT organization_id AS")) return [{ organizationId }];
      if (query.includes("FROM dashboard_installations WHERE")) return [{ id: installationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" }];
      if (query.includes("FROM github_app_config")) return [{}];
      return [];
    }) as never;
    const response = await createControlPlaneApp(fakeHttpDeps({
      db,
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      defaultJobImages: {},
      workerTemplateDigests: { "windows-x64": templateDigest },
    })).request("/api/onboarding");
    expect(response.status).toBe(200);
    expect((await response.json()).defaultImageDigests["windows-x64"]).toBe(templateDigest);
  });

  test("strict detail DTO rejects secret-like nested fields and invalid step", () => {
    const valid = {
      version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "worker", publicBaseUrl: null, publicBaseUrlManaged: false,
      worker: null, organizations: [], github: { appConfigured: false, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: null,
    };
    expect(OnboardingDetail.safeParse(valid).success).toBe(true);
    expect(OnboardingDetail.safeParse({ ...valid, step: "not-a-step" }).success).toBe(false);
    expect(OnboardingDetail.safeParse({ ...valid, github: { ...valid.github, accessToken: "secret" } }).success).toBe(false);
  });
});
