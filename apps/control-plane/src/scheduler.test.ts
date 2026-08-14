import { describe, expect, test } from "bun:test";
import { labelsMatch, reason, type Candidate } from "./scheduler.ts";

const candidate = (requestedLabels: string[], triggerLabel: string | null = "whitesmith-linux-x64"): Candidate => ({
  worker: { admissionState: "adopted", connectionState: "online", configurationState: "ready", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 } },
  pool: { enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["whitesmith-linux-x64"], triggerLabel },
  requestedLabels,
});

describe("runner label routing", () => {
  test("matches one composite label case-insensitively", () => {
    expect(labelsMatch(["WHITESMITH-LINUX-X64"], ["whitesmith-linux-x64"], "whitesmith-linux-x64")).toBe(true);
  });

  test("does not claim split platform and architecture labels", () => {
    expect(labelsMatch(["self-hosted", "linux", "x64"], ["whitesmith-linux-x64"], "whitesmith-linux-x64")).toBe(false);
    expect(reason(candidate(["self-hosted", "linux", "x64"]))).toBe("no_matching_labels");
  });

  test("rejects extra requested labels", () => {
    expect(labelsMatch(["self-hosted", "whitesmith-linux-x64"], ["whitesmith-linux-x64"], "whitesmith-linux-x64")).toBe(false);
  });

  test("rejects a missing trigger label", () => {
    expect(labelsMatch(["whitesmith-linux-x64"], ["whitesmith-linux-x64"], null)).toBe(false);
  });
});
