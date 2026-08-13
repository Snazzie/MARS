import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkerDetail } from "@whitesmith/contracts";
import { WorkerCard, workerOperationalLabel, workerReadinessLabel } from "./WorkerCard.tsx";

test("maps worker connection and draining state to operational labels", () => {
  expect(workerOperationalLabel({ connectionState: "online", draining: false })).toBe("Online");
  expect(workerOperationalLabel({ connectionState: "offline", draining: false })).toBe("Offline");
  expect(workerOperationalLabel({ connectionState: "online", draining: true })).toBe("Draining");
});

test("maps worker configuration state to readiness labels", () => {
  expect(workerReadinessLabel("ready")).toBe("Ready");
  expect(workerReadinessLabel("unconfigured")).toBe("Needs configuration");
  expect(workerReadinessLabel("error")).toBe("Error");
});
test("renders operational and readiness status in the worker card", () => {
  const worker = {
    id: "86afd915-add3-407c-a6c1-1b46803ef713",
    organizationId: null,
    name: "mac-worker",
    platform: "macos-arm64",
    driver: "tart-vm",
    admissionState: "adopted",
    connectionState: "online",
    configurationState: "ready",
    fingerprint: "sha256:worker",
    limits: null,
    doctor: null,
    capacity: { vcpu: { actual: 4, reserved: 0, free: 4 }, memoryBytes: { actual: 8, reserved: 0, free: 8 }, storageBytes: { actual: 10, reserved: 0, free: 10 }, pods: { actual: 1, reserved: 0, free: 1 } },
    activeSandboxes: 0,
    draining: false,
  } as WorkerDetail;
  const markup = renderToStaticMarkup(<WorkerCard worker={worker} organizationId="all" onChange={() => {}} />);
  expect(markup).toContain("Online");
  expect(markup).toContain("Ready");
});
