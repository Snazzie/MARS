import { describe, expect, test } from "bun:test";
import { canSubscribeToOrganization, loadBrowserInvalidations } from "./browser-invalidations.ts";

function fakeDb(rows: unknown[]) {
  return (async () => rows) as never;
}

describe("browser invalidation authorization", () => {
  test("allows global administrators without a membership lookup", async () => {
    let queried = false;
    const db = (async () => { queried = true; return []; }) as never;
    expect(await canSubscribeToOrganization(db, { id: "user-1", isGlobalAdmin: true }, "00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(queried).toBe(false);
  });

  test("requires organization membership for regular users", async () => {
    expect(await canSubscribeToOrganization(fakeDb([{ allowed: true }]), { id: "user-1", isGlobalAdmin: false }, "00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(await canSubscribeToOrganization(fakeDb([]), { id: "user-1", isGlobalAdmin: false }, "00000000-0000-4000-8000-000000000001")).toBe(false);
  });
});

describe("browser invalidation replay", () => {
  test("normalizes durable rows after the requested cursor", async () => {
    const rows = [
      { organizationId: "00000000-0000-4000-8000-000000000001", sequence: "7", keys: ["runs"], occurredAt: new Date("2026-08-16T12:00:00.000Z") },
      { organizationId: "00000000-0000-4000-8000-000000000001", sequence: 8, keys: ["overview", "workers"], occurredAt: "2026-08-16T12:00:01.000Z" },
    ];
    expect(await loadBrowserInvalidations(fakeDb(rows), rows[0]!.organizationId, 6)).toEqual([
      { ...rows[0], sequence: 7, occurredAt: "2026-08-16T12:00:00.000Z" },
      rows[1],
    ]);
  });

  test("clamps invalid cursors before querying", async () => {
    expect(await loadBrowserInvalidations(fakeDb([]), "00000000-0000-4000-8000-000000000001", Number.NaN)).toEqual([]);
  });
});
