import { expect, test } from "bun:test";
import { WorkerDetail } from "@whitesmith/contracts";
import { getOrganizationSettings, listAllWorkers, listWorkers } from "./dashboard.ts";

test("worker listing normalizes persisted telemetry into the WorkerDetail contract", async () => {
  const db = (async () => [{
    id: "86afd915-add3-407c-a6c1-1b46803ef713",
    organizationId: "c432f22a-16e2-44f8-9a6b-bc00e5de1a7d",
    name: "mac-worker",
    platform: "macos-arm64",
    driver: "tart-vm",
    admissionState: "adopted",
    connectionState: "online",
    configurationState: "ready",
    fingerprint: "sha256:worker",
    limits: "{\"maxVcpuPerPod\":2,\"maxMemoryBytesPerPod\":3221225472,\"maxStorageBytesPerPod\":10737418240,\"maxConcurrentPods\":1}",
    doctor: { doctor: { probe: true, egress: true }, capacity: { freeVcpu: 10, actualVcpu: 10, freeMemoryBytes: 16149077032, actualMemoryBytes: 34359738368, freeStorageBytes: 103244165120, actualStorageBytes: 994610155520 } },
    activeSandboxes: 0,
    draining: false,
  }]) as never;

  const page = await listWorkers(db, "c432f22a-16e2-44f8-9a6b-bc00e5de1a7d");

  expect(() => WorkerDetail.parse(page.items[0])).not.toThrow();
  expect(page.items[0]).toMatchObject({ driver: "tart-vm", doctor: { probe: true }, limits: { maxVcpuPerPod: 2 }, capacity: { vcpu: { actual: 10, free: 10 }, memoryBytes: { actual: 34359738368, free: 16149077032 } } });
});

test("organization settings convert PostgreSQL numeric values to numbers", async () => {
  const db = (async () => [{
    organizationId: "org-1",
    maxVcpuPerPod: "4",
    maxMemoryBytesPerPod: "8589934592",
    maxStorageBytesPerPod: "107374182400",
    maxConcurrentPods: "2",
  }]) as never;

  const settings = await getOrganizationSettings(db, "org-1");

  expect(settings).toEqual({
    organizationId: "org-1",
    maxVcpuPerPod: 4,
    maxMemoryBytesPerPod: 8589934592,
    maxStorageBytesPerPod: 107374182400,
    maxConcurrentPods: 2,
  });
});
test("all-workspace worker listing includes workers across organizations", async () => {
  const db = (async () => [
    { id: "w-1", organizationId: "org-1", name: "linux-one", platform: "linux-x64", admissionState: "adopted", connectionState: "online", configurationState: "ready", fingerprint: "sha256:one", limits: null, doctor: null, activeSandboxes: 0, draining: false },
    { id: "w-2", organizationId: "org-2", name: "mac-two", platform: "macos-arm64", admissionState: "pending", connectionState: "offline", configurationState: "unconfigured", fingerprint: "sha256:two", limits: null, doctor: null, activeSandboxes: 0, draining: false },
  ]) as never;

  const page = await listAllWorkers(db, "user-1");
  expect(page.items.map((worker) => worker.organizationId)).toEqual(["org-1", "org-2"]);
});
