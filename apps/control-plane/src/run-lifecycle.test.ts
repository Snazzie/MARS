import { describe, expect, test } from "bun:test";
import { stageDurationMs } from "./runs.ts";

describe("run lifecycle", () => {
  test("calculates completed stage duration", () => {
    expect(stageDurationMs({ startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.250Z" })).toBe(1250);
  });
  test("never produces a negative duration for late timestamps", () => {
    expect(stageDurationMs({ startedAt: "2026-01-01T00:00:02.000Z", completedAt: "2026-01-01T00:00:01.000Z" })).toBe(0);
  });
});
