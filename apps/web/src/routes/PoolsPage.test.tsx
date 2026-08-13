import { expect, test } from "bun:test";
import { poolWorkerCoverage } from "./PoolsPage.tsx";

test("counts compatible shared-pool workers by operational and readiness status", () => {
  const coverage = poolWorkerCoverage({ platform: "macos-arm64", driver: "tart-vm", workerId: null }, [
    { id: "w1", platform: "macos-arm64", driver: "tart-vm", connectionState: "online", configurationState: "ready", draining: false },
    { id: "w2", platform: "macos-arm64", driver: "tart-vm", connectionState: "offline", configurationState: "unconfigured", draining: false },
  ]);
  expect(coverage).toMatchObject({ online: 1, ready: 1, warning: null });
});

test("warns when a pool has no ready workers", () => {
  const coverage = poolWorkerCoverage({ platform: "macos-arm64", driver: "tart-vm", workerId: null }, [
    { id: "w1", platform: "macos-arm64", driver: "tart-vm", connectionState: "offline", configurationState: "error", draining: false },
  ]);
  expect(coverage).toMatchObject({ online: 0, ready: 0, warning: "No ready workers" });
});
