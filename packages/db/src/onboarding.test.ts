import { describe, expect, test } from "bun:test";
import { getOnboardingStatus, selectOnboardingWorker, completeOnboardingIfReady } from "./onboarding.ts";

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
    expect(status).toMatchObject({ version: 1, onboardingRequired: true, adminCreated: false, step: "admin" });
  });

  test("falls back to worker when selected worker is rejected or revoked", async () => {
    const status = await getOnboardingStatus(sql([{ adminUserId: "u1", workerId: "w1", organizationId: null, completedAt: null, workerAdmissionState: "rejected" }]));
    expect(status.step).toBe("worker");
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
