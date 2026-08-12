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
