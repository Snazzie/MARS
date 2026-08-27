import { describe, expect, test } from "bun:test";
import { labelsMatch, parseProvisionLabels, reason, resolveProvisionResources, fits, type Candidate } from "./scheduler.ts";

const candidate = (requestedLabels: string[], triggerLabel: string | null = "mars-linux-x64"): Candidate => ({
  worker: { admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationRevision: "current", appliedConfigurationRevision: "current", runtimeReady: true, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 } },
  pool: { enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-linux-x64"], triggerLabel },
  requestedLabels,
});

describe("runner label routing", () => {
  test("matches one composite label case-insensitively", () => {
    expect(labelsMatch(["MARS-LINUX-X64"], ["mars-linux-x64"], "mars-linux-x64")).toBe(true);
  });

  test("does not claim split platform and architecture labels", () => {
    expect(labelsMatch(["self-hosted", "linux", "x64"], ["mars-linux-x64"], "mars-linux-x64")).toBe(false);
    expect(reason(candidate(["self-hosted", "linux", "x64"]))).toBe("no_matching_labels");
  });
 
  test("matches legacy split platform labels to a composite pool trigger", () => {
    expect(labelsMatch(["self-hosted", "windows", "x64", "mars-default"], ["mars-windows-x64"], "mars-windows-x64")).toBe(true);
  });

  test("rejects extra requested labels", () => {
    expect(labelsMatch(["self-hosted", "mars-linux-x64"], ["mars-linux-x64"], "mars-linux-x64")).toBe(false);
  });

  test("rejects a missing trigger label", () => {
    expect(labelsMatch(["mars-linux-x64"], ["mars-linux-x64"], null)).toBe(false);
  });
});
describe("numeric provision labels", () => {
  test("resolves mixed-case CPU and GiB labels and strips them from routing", () => {
    expect(parseProvisionLabels(["mars-linux-x64", "2VCPU", "6G"])).toEqual({ routingLabels: ["mars-linux-x64"], vcpu: 2, memoryBytes: 6 * 1024 ** 3 });
  });
  test("resolves a 3VCPU request exactly", () => {
    expect(parseProvisionLabels(["mars-linux-x64", "3VCPU"])).toEqual({ routingLabels: ["mars-linux-x64"], vcpu: 3 });
  });
  test("falls back to pool dimensions when absent", () => {
    expect(resolveProvisionResources({ vcpu: 4, memoryBytes: 8, storageBytes: 30, concurrency: 3 }, { routingLabels: [] })).toEqual({ vcpu: 4, memoryBytes: 8, storageBytes: 30, concurrency: 3 });
  });
  test("rejects duplicate, zero, malformed, and overflow provision labels", () => {
    expect(parseProvisionLabels(["1vcpu", "2vcpu"])).toBeNull();
    expect(parseProvisionLabels(["0g"])).toBeNull();
    expect(parseProvisionLabels(["01vcpu"])).toBeNull();
    expect(parseProvisionLabels(["9007199254740991g"])).toBeNull();
  });
  test("accepts CPU override above pool default within worker ceiling", () => {
    const value = candidate(["mars-linux-x64", "2vcpu"]);
    value.pool.resources = { vcpu: 1, memoryBytes: 4, storageBytes: 8, concurrency: 1 };
    expect(fits(value)).toBe(true);
  });
});
test("checks storage against the storage ceiling", () => {
  const value = candidate(["mars-linux-x64", "2vcpu"]);
  value.pool.resources = { vcpu: 2, memoryBytes: 4, storageBytes: 8, concurrency: 1 };
  expect(reason(value)).toBe("admissible");
});
test("blocks a worker whose local runtime is not ready", () => {
  const value = candidate(["mars-linux-x64"]);
  value.worker.runtimeReady = false;
  expect(fits(value)).toBe(false);
  expect(reason(value)).toBe("worker_runtime_not_ready");
});
