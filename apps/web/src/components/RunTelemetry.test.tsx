import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunTelemetry, lifecycleMetrics } from "./RunTelemetry.tsx";

test("derives queue delay, runtime, and lifecycle duration", () => {
  expect(lifecycleMetrics("2026-08-13T14:00:00.000Z", "2026-08-13T14:00:05.000Z", "2026-08-13T14:01:35.000Z")).toEqual({ startDelayMs: 5000, runDurationMs: 90000, lifecycleMs: 95000 });
});

test("renders active telemetry without inventing completion", () => {
  const markup = renderToStaticMarkup(<RunTelemetry queuedAt="2026-08-13T14:00:00.000Z" startedAt={null} completedAt={null} />);
  expect(markup).toContain("Job created");
  expect(markup).toContain("Waiting to start");
  expect(markup).not.toContain("Total lifecycle");
});
