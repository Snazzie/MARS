import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkerDetail } from "@whitesmith/contracts";
import { WorkerCard, workerOperationalLabel, workerReadinessLabel } from "./WorkerCard.tsx";

const workerFixture = (overrides: Partial<WorkerDetail> = {}): WorkerDetail => ({
  id: "86afd915-add3-407c-a6c1-1b46803ef713",
  organizationId: null,
  name: "mac-worker",
  platform: "macos-arm64",
  driver: "tart-vm",
  guestPlatforms: ["macos-arm64"],
  admissionState: "adopted",
  connectionState: "online",
  configurationState: "ready",
  configurationRevision: "a".repeat(64),
  appliedConfigurationRevision: "a".repeat(64),
  configurationAppliedAt: "2026-08-16T12:00:00.000Z",
  lastHeartbeatAt: "2026-08-16T12:01:00.000Z",
  lastDoctorAt: "2026-08-16T12:00:30.000Z",
  runtimeMode: "tart",
  artifactDigest: "sha256:" + "b".repeat(64),
  fingerprint: "sha256:worker",
  limits: null,
  doctor: null,
  capacity: { vcpu: { actual: 4, reserved: 0, free: 4 }, memoryBytes: { actual: 8, reserved: 0, free: 8 }, storageBytes: { actual: 10, reserved: 0, free: 10 }, pods: { actual: 1, reserved: 0, free: 1 } },
  activeSandboxes: 0,
  draining: false,
  ...overrides,
});

test("maps worker connection and draining state to operational labels", () => {
  expect(workerOperationalLabel({ connectionState: "online", draining: false })).toBe("Online");
  expect(workerOperationalLabel({ connectionState: "offline", draining: false })).toBe("Offline");
  expect(workerOperationalLabel({ connectionState: "online", draining: true })).toBe("Draining");
});

test("maps worker configuration state to readiness labels", () => {
  expect(workerReadinessLabel("ready")).toBe("Ready");
  expect(workerReadinessLabel("unconfigured")).toBe("Needs configuration");
  expect(workerReadinessLabel("error")).toBe("Error");
  expect(workerReadinessLabel("applying")).toBe("Applying configuration");
});
test("renders operational and readiness status in the worker card", () => {
  const worker = workerFixture();
  const markup = renderToStaticMarkup(<WorkerCard worker={worker} organizationId="all" onChange={() => {}} />);
  expect(markup).toContain(">online</span>");
  expect(markup).not.toContain("Needs configuration");
});

test("shows applying configuration until the desired revision is acknowledged", () => {
  const worker = workerFixture({ configurationState: "applying", configurationRevision: "b".repeat(64), doctor: { egress: true } });
  const markup = renderToStaticMarkup(<WorkerCard worker={worker} organizationId="all" onChange={() => {}} />);
  expect(markup).toContain("Applying configuration");
  expect(markup).toContain("Runtime checks pass");
  expect(markup).not.toContain("Ready for dispatch");
  expect(markup).not.toContain("Configuration updated");
});

test("shows the exact applied revision and acknowledgement time", () => {
  const worker = workerFixture();
  const markup = renderToStaticMarkup(<WorkerCard worker={worker} organizationId="all" onChange={() => {}} />);
  expect(markup).toContain("Configuration updated");
  expect(markup).toContain("aaaaaaaaaaaa");
  expect(markup).toContain("Aug");
});

test("retains the last successful acknowledgement when an update fails", () => {
  const worker = workerFixture({ configurationState: "error", configurationRevision: "b".repeat(64) });
  const markup = renderToStaticMarkup(<WorkerCard worker={worker} organizationId="all" onChange={() => {}} />);
  expect(markup).toContain("Configuration update failed");
  expect(markup).toContain("Last applied");
  expect(markup).toContain("aaaaaaaaaaaa");
});
