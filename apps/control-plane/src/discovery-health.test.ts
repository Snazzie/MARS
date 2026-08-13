import { describe, expect, test } from "bun:test";
import { DiscoveryHealthMonitor, isDiscoveryCycleSuccessful } from "./discovery-health.ts";

test("treats an isolated repository failure as a successful discovery cycle", () => {
  expect(isDiscoveryCycleSuccessful({ repositories: 6, failed: 5 })).toBe(true);
  expect(isDiscoveryCycleSuccessful({ repositories: 6, failed: 6 })).toBe(false);
  expect(isDiscoveryCycleSuccessful({ repositories: 0, failed: 0 })).toBe(true);
});

describe("DiscoveryHealthMonitor", () => {
  test("becomes stale after two intervals and alerts once per stale episode", () => {
    const monitor = new DiscoveryHealthMonitor(30_000, 1_000);

    expect(monitor.snapshot(60_999).stale).toBe(false);
    expect(monitor.consumeStaleAlert(61_000)).toBe(true);
    expect(monitor.snapshot(61_000).stale).toBe(true);
    expect(monitor.consumeStaleAlert(70_000)).toBe(false);

    monitor.markAttempt(71_000);
    monitor.markSuccess(72_000);
    expect(monitor.snapshot(131_999)).toEqual({
      lastAttemptAt: "1970-01-01T00:01:11.000Z",
      lastSuccessAt: "1970-01-01T00:01:12.000Z",
      stale: false,
      staleAfterMs: 60_000,
    });
    expect(monitor.consumeStaleAlert(132_000)).toBe(true);
  });

  test("does not treat an attempt as a successful discovery", () => {
    const monitor = new DiscoveryHealthMonitor(5_000, 10_000);
    monitor.markAttempt(12_000);

    expect(monitor.snapshot(20_000)).toEqual({
      lastAttemptAt: "1970-01-01T00:00:12.000Z",
      lastSuccessAt: null,
      stale: true,
      staleAfterMs: 10_000,
    });
  });
});
