import { describe, expect, test } from "bun:test";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";
import { completeOnboardingIfReady, getOnboardingDetail, getOnboardingStatus, selectOnboardingWorker } from "./onboarding.ts";
const client = (seed: Record<string, unknown[]> = {}) => ({ db: preparedTestDatabase((name) => seed[name] ?? []) });
describe("onboarding state derivation", () => {
  test("derives server step order from durable prerequisites", async () => {
    const status = await getOnboardingStatus(client({ onboarding_status: [{ adminUserId: null, workerId: null, organizationId: null, completedAt: null }] }).db);
    expect(status).toMatchObject({ version: 1, onboardingRequired: true, adminCreated: false, step: "setup" });
  });

  test("returns the persisted public origin and caller-supplied managed flag", async () => {
    const status = await getOnboardingStatus(client({ onboarding_status: [{ adminUserId: null, workerId: null, organizationId: null, completedAt: null, publicBaseUrl: "https://control.example.com", originConfigured: true, githubAppConfigured: false }] }).db, {}, { publicBaseUrlManaged: true });
    expect(status).toMatchObject({ publicBaseUrl: "https://control.example.com", publicBaseUrlManaged: true });
  });

  test("falls back to worker when selected worker is rejected or revoked", async () => {
    const status = await getOnboardingStatus(client({ onboarding_status: [{ adminUserId: "u1", workerId: "w1", organizationId: null, completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "rejected" }] }).db);
    expect(status.step).toBe("worker");
  });

  test("keeps selected workers on Worker until adoption and configuration acknowledgement", async () => {
    for (const row of [{ workerAdmissionState: "pending", workerConfigurationState: "unconfigured" }, { workerAdmissionState: "adopted", workerConfigurationState: "unconfigured" }]) {
      const db = client({ onboarding_status: [{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, githubReady: true, ...row }] }).db;
      expect((await getOnboardingStatus(db)).step).toBe("worker");
    }
  });

  test("advances a ready adopted worker through GitHub to trigger labels", async () => {
    const github = client({ onboarding_status: [{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: false }] }).db;
    expect((await getOnboardingStatus(github)).step).toBe("github");
    const labels = client({ onboarding_status: [{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: true }] }).db;
    expect((await getOnboardingStatus(labels)).step).toBe("labels");
  });

  test("uses available repositories from an approved installation for GitHub readiness", async () => {
    const db = client({ onboarding_status: [{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: null, originConfigured: true, githubAppConfigured: true, workerAdmissionState: "adopted", workerConfigurationState: "ready", githubReady: true }] }).db;
    expect((await getOnboardingStatus(db)).step).toBe("labels");
  });

  test("does not complete before a verification run is recorded", async () => {
    const db = client({ onboarding_completion_state: [{ completedAt: null, adminUserId: "admin", workerId: "worker", organizationId: "org", verificationPoolId: null, verificationGithubRunId: null }] }).db;
    expect(await completeOnboardingIfReady(db)).toBe(false);
  });

  test("completes after an enabled default pool without verification when requested", async () => {
    const { db } = client({
      onboarding_completion_state: [{ completedAt: null, adminUserId: "admin", workerId: "worker", organizationId: "org", verificationPoolId: null, verificationGithubRunId: null }],
      onboarding_skip_verification_ready: [{ ready: 1 }], onboarding_complete: [{ completedAt: new Date() }],
    });
    expect(await completeOnboardingIfReady(db, { skipVerification: true })).toBe(true);
  });

  test("normalizes repository discovery state in onboarding detail", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const installationId = "00000000-0000-4000-8000-000000000003";
    const repositoryId = "00000000-0000-4000-8000-000000000004";
    const retryAt = new Date(Date.now() + 60 * 60 * 1_000);
    const db = client({
      onboarding_status: [{ adminUserId: "admin", workerId: null, organizationId, completedAt: null }],
      onboarding_state: [{ organizationId }], onboarding_installation: [{ id: installationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" }],
      onboarding_repositories: [{ id: repositoryId, organizationId, name: "repo", fullName: "acme/repo", visibility: "private", available: true, installationId, discoveryError: "github_403", discoveryRetryAt: retryAt }],
      onboarding_app_configured: [{ configured: true }],
    }).db;
    expect((await getOnboardingDetail(db)).github.repositories).toEqual([{ id: repositoryId, organizationId, name: "repo", fullName: "acme/repo", visibility: "private", available: true, installationId, discoveryState: "paused", discoveryRetryAt: retryAt.toISOString() }]);
  });

  test("completion is sticky after later resource failures", async () => {
    const db = client({ onboarding_status: [{ adminUserId: "u1", workerId: "w1", organizationId: "o1", completedAt: "2026-08-12T00:00:00Z", workerAdmissionState: "revoked" }], onboarding_completion_state: [{ completedAt: "2026-08-12T00:00:00Z" }] }).db;
    expect(await getOnboardingStatus(db)).toMatchObject({ onboardingRequired: false, step: "complete" });
    expect(await completeOnboardingIfReady(db)).toBe(false);
  });

  test("selection rejects unavailable workers", async () => {
    await expect(selectOnboardingWorker(client().db, "w-foreign", "admin-1")).rejects.toThrow();
  });

  test("normalizes legacy selected-worker telemetry without capacity", async () => {
    const workerId = "00000000-0000-0000-0000-000000000001";
    const db = client({
      onboarding_status: [{ adminUserId: "admin", workerId, organizationId: null, completedAt: null, workerAdmissionState: "pending", workerConfigurationState: "unconfigured" }],
      onboarding_selected_worker: [{ id: workerId, name: "windows-worker", platform: "windows-x64", guestPlatforms: ["windows-x64"], admissionState: "pending", connectionState: "offline", configurationState: "unconfigured", publicKey: "public", fingerprint: "fingerprint", vmUuid: workerId, machineUuid: workerId, doctor: { probe: true, containers: [] }, limits: null, configurationRevision: null }],
    }).db;
    const detail = await getOnboardingDetail(db);
    expect(detail.worker?.capacity).toEqual({ actualVcpu: 0, actualMemoryBytes: 0, actualStorageBytes: 0, freeVcpu: 0, freeMemoryBytes: 0, freeStorageBytes: 0 });
    expect(detail.worker?.doctor).toEqual({ probe: true, containers: [] });
  });
});
