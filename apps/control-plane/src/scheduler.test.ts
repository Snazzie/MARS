import { describe, expect, test } from "bun:test";
import { parseRunnerLabels } from "@mars/contracts";
import { fits, reason, selectProvisionOption, type Candidate } from "./scheduler.ts";

const GiB = 1024 ** 3;
const candidate = (requestedLabels: string[], platform = "linux-x64", triggerLabel: string | null = `mars-${platform}`): Candidate => ({
  worker: { admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationRevision: "current", appliedConfigurationRevision: "current", runtimeReady: true, limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GiB, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 } },
  pool: { enabled: true, platform, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: [`mars-${platform}`], triggerLabel },
  requestedLabels,
});

describe("runner label routing", () => {
  test("selects the exact Ubuntu image version over neutral alternatives", () => {
    for (const version of ["22", "24", "26"]) {
      const route = `mars-ubuntu-${version}`;
      const options = parseRunnerLabels([
        "mars-any-2vcpu-4g",
        "mars-any-x64-3vcpu-5g",
        `${route.toUpperCase()}-4vcpu-6g`,
      ]);
      expect(options).not.toBeNull();
      expect(selectProvisionOption(options!, { platform: "linux-x64", labels: [route], triggerLabel: route })).toMatchObject({ route, vcpu: 4, memoryGiB: 6 });
      const otherVersion = version === "22" ? "24" : "22";
      expect(selectProvisionOption(parseRunnerLabels([`${route}-2vcpu-4g`])!, { platform: "linux-x64", labels: [`mars-ubuntu-${otherVersion}`], triggerLabel: `mars-ubuntu-${otherVersion}` })).toBeNull();
    }
  });

  test("matches x64 neutral alternatives only on x64 pools", () => {
    const options = parseRunnerLabels(["mars-any-x64-2vcpu-4g"]);
    expect(options).not.toBeNull();
    expect(selectProvisionOption(options!, { platform: "linux-x64", labels: [], triggerLabel: null })).not.toBeNull();
    expect(selectProvisionOption(options!, { platform: "macos-arm64", labels: [], triggerLabel: null })).toBeNull();
  });

  test("accepts future routes but leaves unavailable platforms unmatched", () => {
    const options = parseRunnerLabels(["mars-windows-arm64-2vcpu-4g"]);
    expect(options).not.toBeNull();
    expect(selectProvisionOption(options!, { platform: "windows-x64", labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" })).toBeNull();
  });

  test("rejects split and duplicate alternatives", () => {
    expect(parseRunnerLabels(["self-hosted", "linux", "x64"])).toBeNull();
    expect(parseRunnerLabels(["mars-linux-x64-2vcpu-4g", "MARS-LINUX-X64-3vcpu-5g"])).toBeNull();
    expect(parseRunnerLabels(["mars-linux-x64-2vcpu-4g", "mars-linux-x64-2vcpu-4g"])).toBeNull();
  });
});

describe("composite resource labels", () => {
  test("parses route and mandatory resources", () => {
    expect(parseRunnerLabels(["MARS-LINUX-X64-2VCPU-6G"])).toMatchObject([{ original: "MARS-LINUX-X64-2VCPU-6G", route: "mars-linux-x64", vcpu: 2, memoryGiB: 6, memoryBytes: 6 * GiB }]);
  });

  test("rejects standalone, missing, zero, and overflow resources", () => {
    for (const labels of [["2vcpu"], ["15g"], ["mars-linux-x64"], ["mars-linux-x64-0vcpu-4g"], ["mars-linux-x64-2vcpu-0g"], ["mars-linux-x64-2vcpu-9007199254740991g"]]) {
      expect(parseRunnerLabels(labels)).toBeNull();
    }
  });

  test("checks selected composite resources against worker ceilings", () => {
    const value = candidate(["mars-linux-x64-2vcpu-6g"]);
    expect(fits(value)).toBe(true);
    value.requestedLabels = ["mars-linux-x64-5vcpu-6g"];
    expect(fits(value)).toBe(false);
    expect(reason(value)).toBe("resource_ceiling");
  });

  test("uses pool storage and concurrency while checking selected resources", () => {
    const value = candidate(["mars-linux-x64-2vcpu-4g"]);
    value.pool.resources = { vcpu: 2, memoryBytes: 4, storageBytes: 8, concurrency: 1 };
    expect(reason(value)).toBe("admissible");
  });
});

test("blocks a worker whose local runtime is not ready", () => {
  const value = candidate(["mars-linux-x64-2vcpu-4g"]);
  value.worker.runtimeReady = false;
  expect(fits(value)).toBe(false);
  expect(reason(value)).toBe("worker_runtime_not_ready");
});
