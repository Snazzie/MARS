import { expect, test } from "bun:test";
import { stageDurationMs, type GithubStepSnapshot } from "./runs.ts";

test("step duration is monotonic-compatible for terminal timestamps", () => {
  const step: GithubStepSnapshot = { id: "9", number: 1, name: "build", status: "completed", conclusion: "success", queuedAt: "2026-08-13T00:00:00Z", startedAt: "2026-08-13T00:01:00Z", completedAt: "2026-08-13T00:02:00Z", durationMs: 60_000 };
  expect(step.startedAt).toBe("2026-08-13T00:01:00Z");
  expect(step.completedAt).toBe("2026-08-13T00:02:00Z");
  expect(step.durationMs).toBe(stageDurationMs({ startedAt: step.startedAt!, completedAt: step.completedAt }));
});

test("queued steps never expose a start timestamp", () => {
  const step: GithubStepSnapshot = { id: null, number: 1, name: "build", status: "queued", conclusion: null, queuedAt: "2026-08-13T00:00:00Z", startedAt: null, completedAt: null, durationMs: 0 };
  expect(step.startedAt).toBeNull();
  expect(step.completedAt).toBeNull();
});
