import { expect, test } from "bun:test";
import { LeaseBootstrapEnvelope, RunnerJitConfig } from "./orchestration.ts";

test("parses a GitHub JIT config with a one-time lease binding", () => {
  expect(RunnerJitConfig.parse({
    encodedJitConfig: "encoded",
    runnerName: "whitesmith-lease-1",
    labels: ["self-hosted", "macos", "arm64", "whitesmith-default"],
    expiresAt: "2026-08-12T12:00:00.000Z",
  })).toMatchObject({ runnerName: "whitesmith-lease-1" });
  expect(LeaseBootstrapEnvelope.safeParse({
    leaseId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    nonce: "n".repeat(32),
    encodedJitConfig: "encoded",
    expiresAt: "2026-08-12T12:00:00.000Z",
    imageDigest: "sha256:test",
    resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 },
  }).success).toBe(true);
});

test("rejects JIT config without runner labels", () => {
  expect(RunnerJitConfig.safeParse({ encodedJitConfig: "encoded", runnerName: "runner", labels: [], expiresAt: "2026-08-12T12:00:00.000Z" }).success).toBe(false);
});
