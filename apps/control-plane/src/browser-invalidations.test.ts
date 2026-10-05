import { describe, expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { canSubscribeToOrganization, loadBrowserInvalidations } from "./browser-invalidations.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";

describe("browser invalidation authorization", () => {
  test("allows global administrators without a membership lookup", async () => {
    const db = preparedTestDatabase(() => { throw new Error("global administrators need no membership lookup"); });
    expect(await canSubscribeToOrganization(db, { id: "user-1", isGlobalAdmin: true }, organizationId)).toBe(true);
  });
  test("requires organization membership for regular users", async () => {
    expect(await canSubscribeToOrganization(preparedTestDatabase((name) => name === "browser_invalidation_membership" ? [{ allowed: true }] : []), { id: "user-1", isGlobalAdmin: false }, organizationId)).toBe(true);
    expect(await canSubscribeToOrganization(preparedTestDatabase(() => []), { id: "user-1", isGlobalAdmin: false }, organizationId)).toBe(false);
  });
});

describe("browser invalidation replay", () => {
  test("normalizes durable rows after the requested cursor", async () => {
    const rows = [
      { organizationId, sequence: "7", keys: ["runs"], occurredAt: new Date("2026-08-16T12:00:00.000Z") },
      { organizationId, sequence: 8, keys: ["overview", "workers"], occurredAt: "2026-08-16T12:00:01.000Z" },
    ];
    expect(await loadBrowserInvalidations(preparedTestDatabase((name) => name === "browser_invalidation_replay" ? rows : []), organizationId, 6)).toEqual([
      { ...rows[0], sequence: 7, occurredAt: "2026-08-16T12:00:00.000Z" },
      { ...rows[1], sequence: 8, occurredAt: "2026-08-16T12:00:01.000Z" },
    ]);
  });
  test("clamps invalid cursors before querying", async () => {
    let parameters: Record<string, unknown> | undefined;
    const db = preparedTestDatabase((name, args) => { if (name === "browser_invalidation_replay") parameters = args; return []; });
    expect(await loadBrowserInvalidations(db, organizationId, Number.NaN)).toEqual([]);
    expect(parameters).toMatchObject({ cursor: 0, limit: 100 });
  });
});
