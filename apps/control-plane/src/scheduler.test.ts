import { describe, expect, test } from "bun:test";
import { labelsMatch, reason, type Candidate } from "./scheduler.ts";

const candidate = (requestedLabels: string[], triggerLabel: string | null = "whitesmith-default"): Candidate => ({
  worker: { admissionState: "adopted", connectionState: "online", configurationState: "ready", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 } },
  pool: { enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "linux", "x64", "whitesmith-default"], triggerLabel },
  requestedLabels,
});

describe("self-hosted runner label routing", () => {
  test("matches labels cumulatively and case-insensitively", () => {
    expect(labelsMatch(["SELF-HOSTED", "Linux", "X64", "WHITESMITH-DEFAULT"], ["self-hosted", "linux", "x64", "whitesmith-default"], "whitesmith-default")).toBe(true);
  });

  test("requires the pool trigger label", () => {
    expect(labelsMatch(["self-hosted", "linux", "x64"], ["self-hosted", "linux", "x64", "whitesmith-default"], "whitesmith-default")).toBe(false);
    expect(reason(candidate(["self-hosted", "linux", "x64"]))).toBe("no_matching_labels");
  });

  test("does not claim generic platform labels for a trigger pool", () => {
    expect(labelsMatch(["self-hosted", "linux", "x64"], ["self-hosted", "linux", "x64", "whitesmith-default"], "whitesmith-default")).toBe(false);
    expect(reason(candidate(["self-hosted", "linux", "x64"]))).toBe("no_matching_labels");
  });

  test("rejects a missing trigger label even when requested labels otherwise match", () => {
    expect(labelsMatch(["self-hosted", "linux", "x64", "whitesmith-default"], ["self-hosted", "linux", "x64"], null)).toBe(false);
  });
});
