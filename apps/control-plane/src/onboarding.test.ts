import { describe, expect, test } from "bun:test";
import { createControlPlaneApp } from "./http/app.ts";
import { fakeHttpDeps } from "./http/test-deps.ts";
import { OnboardingStatus, OnboardingDetail, SelectOnboardingWorkerRequest } from "@whitesmith/contracts";

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
      version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "worker",
      worker: null, organizations: [], github: { appConfigured: false, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: null,
    };
    expect(OnboardingDetail.safeParse(valid).success).toBe(true);
    expect(OnboardingDetail.safeParse({ ...valid, step: "not-a-step" }).success).toBe(false);
    expect(OnboardingDetail.safeParse({ ...valid, github: { ...valid.github, accessToken: "secret" } }).success).toBe(false);
  });
});
