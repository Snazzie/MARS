import { describe, expect, test } from "bun:test";
import { completeOnboardingIfReady, getOnboardingDetail, getOnboardingStatus, selectOnboardingWorker } from "./onboarding.ts";

const sql = (rows: unknown[] = []) => {
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = Array.from(strings).join(" ").toLowerCase();
    if (query.includes("system_onboarding")) return rows;
    return [];
  }) as never;
  return db;
};

describe("onboarding state derivation", () => {
  test("derives server step order from durable prerequisites", async () => {
    const status = await getOnboardingStatus(sql([{ adminUserId: null, workerId: null, organizationId: null, completedAt: null }]));
    expect(status).toMatchObject({ version: 1, onboardingRequired: true, adminCreated: false, step: "setup" });
  });

  test("returns the persisted public origin and caller-supplied managed flag", async () => {
    const status = await getOnboardingStatus(sql([{ adminUserId: null, workerId: null, organizationId: null, completedAt: null, publicBaseUrl: "https://control.example.com", originConfigured: true, githubAppConfigured: false }]), {}, { publicBaseUrlManaged: true });
    expect(status).toMatchObject({ publicBaseUrl: "https://control.example.com", publicBaseUrlManaged: true });
  });

  test("falls back to worker when selected worker is rejected or revoked", async () => {
    const status = await getOnboardingStatus(sql([{ adminUserId: "u1", workerId: "w1", organizationId: null, completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "rejected" }]));
    expect(status.step).toBe("worker");
  });

  test("keeps selected workers on Worker until adoption and configuration acknowledgement", async () => {
    for (const row of [
      { workerAdmissionState: "pending", workerConfigurationState: "unconfigured" },
      { workerAdmissionState: "adopted", workerConfigurationState: "unconfigured" },
    ]) {
      const db = sql([{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, githubReady: true, ...row }]);
      expect((await getOnboardingStatus(db)).step).toBe("worker");
    }
  });

  test("advances a ready adopted worker through GitHub to trigger labels", async () => {
    const github = sql([{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: false }]);
    expect((await getOnboardingStatus(github)).step).toBe("github");
    const labels = sql([{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: true }]);
    expect((await getOnboardingStatus(labels)).step).toBe("labels");
  });

  test("uses every available repository from an active installation for GitHub readiness", async () => {
    let query = "";
    const db = (async (strings: TemplateStringsArray) => {
      query = strings.join(" ").toLowerCase();
      return [{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: true }];
    }) as never;
    expect((await getOnboardingStatus(db)).step).toBe("labels");
    expect(query).toContain("r.available=true");
    expect(query).toContain("i.state='approved'");
    expect(query).not.toContain("r.approved");
    expect(query).not.toContain("visibility");
  });
  test("completes only after a successful smoke run is reaped", async () => {
    const workerId = "00000000-0000-4000-8000-000000000001";
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const poolId = "00000000-0000-4000-8000-000000000003";
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      const normalized = query.toLowerCase();
      if (query.includes('so.admin_user_id AS "adminUserId"')) return [{ adminUserId: "admin", workerId, organizationId, completedAt: null, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: true }];
      if (query.includes("FROM workers w JOIN system_onboarding")) return [{ id: workerId, name: "windows-worker", platform: "windows-x64", guestPlatforms: ["windows-x64"], admissionState: "adopted", connectionState: "online", configurationState: "ready", publicKey: "public", fingerprint: "fingerprint", vmUuid: workerId, machineUuid: workerId, doctor: { doctor: {}, capacity: { actualVcpu: 4, actualMemoryBytes: 8_589_934_592, actualStorageBytes: 42_949_672_960, freeVcpu: 4, freeMemoryBytes: 8_589_934_592, freeStorageBytes: 42_949_672_960 } }, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_294_967_296, maxStorageBytesPerPod: 21_474_836_480, maxConcurrentPods: 1 }, configurationRevision: "a".repeat(64) }];
      if (query.includes("SELECT organization_id AS")) return [{ organizationId }];
      if (query.includes("FROM runner_pools") && normalized.includes("p.organization_id is null")) return [{ id: poolId, organizationId: null, workerId: null, workerName: "Shared fleet", name: "default", platform: "windows-x64", driver: "windows-hyperv-container", imageDigest: `sha256:${"a".repeat(64)}`, resources: { vcpu: 2, memoryBytes: 2_147_483_648, storageBytes: 10_737_418_240, concurrency: 1 }, labels: ["self-hosted", "windows", "x64", "mars-default"], triggerLabel: "mars-default", enabled: true, active: 0 }];
      if (query.includes("JOIN dashboard_runs")) return [{ ready: 1 }];
      if (query.includes("UPDATE system_onboarding SET completed_at")) return [{ completed_at: new Date() }];
      if (query.includes("FROM organizations")) return [];
      if (query.includes("FROM system_onboarding")) return [{ completedAt: null, adminUserId: "admin", workerId, organizationId, verificationPoolId: poolId, verificationGithubRunId: 42 }];
      return [];
    }) as never;
    expect((await getOnboardingDetail(db)).pool).toMatchObject({ id: poolId, platform: "windows-x64", driver: "windows-hyperv-container" });
    expect(await completeOnboardingIfReady(db)).toBe(true);
  });
  test("does not complete before a verification run is recorded", async () => {
    const db = (async (strings: TemplateStringsArray) => strings.join(" ").includes("FROM system_onboarding")
      ? [{ completedAt: null, adminUserId: "admin", workerId: "worker", organizationId: "org", verificationPoolId: null, verificationGithubRunId: null }]
      : []) as never;
    expect(await completeOnboardingIfReady(db)).toBe(false);
  });
  test("normalizes repository discovery state in onboarding detail", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const installationId = "00000000-0000-4000-8000-000000000003";
    const repositoryId = "00000000-0000-4000-8000-000000000004";
    const retryAt = new Date(Date.now() + 60 * 60 * 1_000);
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes('so.admin_user_id AS "adminUserId"')) return [{ adminUserId: "admin", workerId: null, organizationId, completedAt: null }];
      if (query.includes("FROM organizations")) return [];
      if (query.includes('SELECT organization_id AS "organizationId"')) return [{ organizationId }];
      if (query.includes("FROM dashboard_installations")) return [{ id: installationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" }];
      if (query.includes("FROM dashboard_repositories WHERE")) return [{ id: repositoryId, organizationId, name: "repo", fullName: "acme/repo", visibility: "private", available: true, installationId, discoveryError: "github_403", discoveryRetryAt: retryAt }];
      if (query.includes("FROM github_app_config")) return [{ configured: true }];
      return [];
    }) as never;

    expect((await getOnboardingDetail(db)).github.repositories).toEqual([{
      id: repositoryId,
      organizationId,
      name: "repo",
      fullName: "acme/repo",
      visibility: "private",
      available: true,
      installationId,
      discoveryState: "paused",
      discoveryRetryAt: retryAt.toISOString(),
    }]);
  });
  test("completion is sticky after later resource failures", async () => {
    const db = sql([{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: "2026-08-12T00:00:00Z", workerAdmissionState: "revoked" }]);
    const status = await getOnboardingStatus(db);
    expect(status).toMatchObject({ onboardingRequired: false, step: "complete" });
    expect(await completeOnboardingIfReady(db)).toBe(false);
  });

  test("selection rejects foreign and inactive workers", async () => {
    await expect(selectOnboardingWorker(sql([]), "w-foreign", "admin-1")).rejects.toThrow();
    await expect(selectOnboardingWorker(sql([{ id: "w1", admissionState: "rejected" }]), "w1", "admin-1")).rejects.toThrow();
  });
});
