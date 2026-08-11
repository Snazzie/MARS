import { describe, expect, test } from "bun:test";
import { createDashboardApi } from "./dashboard-api.ts";

function fakeDb(rows: unknown[] = [], memberAllowed = true) {
  return Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    if (query.includes("FROM memberships")) return memberAllowed ? [{ ok: true }] : [];
    if (query.includes("FROM organizations")) return rows;
    return [];
  }, {}) as never;
}
const member = { id: "u1", githubUserId: 1, login: "member", isGlobalAdmin: false };
const admin = { id: "u2", githubUserId: 2, login: "admin", isGlobalAdmin: true };

describe("dashboard API", () => {
  test("denies foreign organization as not found", async () => {
    const api = createDashboardApi({ db: fakeDb([], false) });
    const response = await api(new Request("http://x/api/v1/organizations/foreign/overview"), member);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ code: "not_found" });
  });
  test("rejects malformed cursors", async () => {
    const api = createDashboardApi({ db: fakeDb() });
    const response = await api(new Request("http://x/api/v1/organizations/org/runs?cursor=bad.cursor"), member);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ code: "invalid_query" });
  });
  test("uses typed errors and requires idempotency key", async () => {
    const api = createDashboardApi({ db: fakeDb() });
    const response = await api(new Request("http://x/api/v1/organizations/org/workers/w1/drain", { method: "POST" }), member);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ code: "missing_idempotency_key", requestId: expect.any(String) });
  });
  test("restricts worker adopt to global administrators", async () => {
    const api = createDashboardApi({ db: fakeDb() });
    const response = await api(new Request("http://x/api/v1/organizations/org/workers/w1/adopt", { method: "POST", headers: { "Idempotency-Key": "one" } }), member);
    expect(response?.status).toBe(404);
    const adminResponse = await api(new Request("http://x/api/v1/organizations/org/workers/w1/adopt", { method: "POST", headers: { "Idempotency-Key": "two" } }), admin);
    expect(adminResponse?.status).toBe(404);
  });
});
