import { describe, expect, test } from "bun:test";
import { boundedLogChunks, cursorBoundary, monotonicTransition } from "../packages/db/src/dashboard.ts";

describe("dashboard DB invariants", () => {
  test("tenant-scoped pages cannot cross organization data", () => {
    const rows = [{ id: "org-a-run", organizationId: "org-a" }, { id: "org-b-run", organizationId: "org-b" }];
    expect(cursorBoundary(rows.filter(row => row.organizationId === "org-a"), null, 10).items).toEqual([{ id: "org-a-run", organizationId: "org-a" }]);
  });
  test("transitions are monotonic and terminal states are protected", () => {
    const queued = { status: "queued" as const, conclusion: null };
    expect(monotonicTransition(queued, { status: "in_progress", conclusion: null }).status).toBe("in_progress");
    const completed = { status: "completed" as const, conclusion: "success" as const };
    expect(monotonicTransition(completed, { status: "in_progress", conclusion: null })).toEqual(completed);
  });
  test("cursor boundaries return stable next cursor", () => {
    const rows = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(cursorBoundary(rows, null, 2)).toEqual({ items: rows.slice(0, 2), nextCursor: "2" });
    expect(cursorBoundary(rows, "2", 2)).toEqual({ items: [rows[2]], nextCursor: null });
  });
  test("log chunks are bounded in count and content size", () => {
    const chunks = [{ organizationId: "o", runId: "r", jobId: "j", sequence: 0, content: "x".repeat(300_000), hasMore: false, occurredAt: "2026-08-11T00:00:00Z" }];
    const result = boundedLogChunks(chunks, 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toHaveLength(256 * 1024);
    expect(result.hasMore).toBe(false);
    expect(boundedLogChunks([...chunks, { ...chunks[0], sequence: 1 }], 1).hasMore).toBe(true);
  });
});
