import { expect, test } from "bun:test";
import { poolWorkerCoverage } from "./PoolsPage.tsx";

test("counts compatible shared-pool workers by operational and readiness status", () => {
  const coverage = poolWorkerCoverage({ platform: "macos-arm64", driver: "tart-vm", workerId: null, imageDigest: "macos" }, [
    { id: "w1", name: "worker-1", platform: "macos-arm64", driver: "tart-vm", selectedDriver: "tart-vm", artifactDigest: "macos", artifactDigests: { "macos-arm64": "macos" }, connectionState: "online", configurationState: "ready", configurationRevision: "a", appliedConfigurationRevision: "a", draining: false, doctor: { runtimeReady: true, probe: true, imageSignatures: true, capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: "macos", ready: true, remediation: null }] } },
    { id: "w2", name: "worker-2", platform: "macos-arm64", driver: "tart-vm", selectedDriver: "tart-vm", artifactDigest: "macos", artifactDigests: { "macos-arm64": "macos" }, connectionState: "offline", configurationState: "unconfigured", configurationRevision: null, appliedConfigurationRevision: null, draining: false },
  ]);
  expect(coverage).toMatchObject({ online: 1, ready: 1, warning: null });
});

test("does not mark a configured worker ready when its runtime doctor fails", () => {
  const coverage = poolWorkerCoverage({ platform: "macos-arm64", driver: "tart-vm", workerId: null, imageDigest: "macos" }, [
    { id: "w1", name: "worker-1", platform: "macos-arm64", driver: "tart-vm", selectedDriver: "tart-vm", artifactDigest: "macos", artifactDigests: { "macos-arm64": "macos" }, connectionState: "online", configurationState: "ready", configurationRevision: "a", appliedConfigurationRevision: "a", draining: false, doctor: { runtimeReady: false, capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: "macos", ready: true, remediation: null }] } },
  ]);
  expect(coverage).toMatchObject({ online: 1, ready: 0, warning: "No compatible ready worker" });
});

test("warns when a pool has no ready workers", () => {
  const coverage = poolWorkerCoverage({ platform: "macos-arm64", driver: "tart-vm", workerId: null, imageDigest: "macos" }, [
    { id: "w1", name: "worker-1", platform: "macos-arm64", driver: "tart-vm", selectedDriver: "tart-vm", artifactDigest: "other", artifactDigests: { "macos-arm64": "other" }, connectionState: "offline", configurationState: "error", configurationRevision: "b", appliedConfigurationRevision: "a", draining: false, doctor: { capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: "other", ready: true, remediation: null }] } },
  ]);
  expect(coverage).toMatchObject({ online: 0, ready: 0, warning: "No compatible ready worker" });
});
