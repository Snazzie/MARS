import { expect, test } from "bun:test";
import type { LeaseBootstrapEnvelope, WorkerCommand, WorkerEvent } from "@whitesmith/contracts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const command: WorkerCommand = { version: 1, id: "33333333-3333-4333-8333-333333333333", type: "windows-container.create_lease", workerId, leaseId, occurredAt: new Date().toISOString(), payload: {} };
const bootstrap: LeaseBootstrapEnvelope = { leaseId, jobId: leaseId, nonce: "n".repeat(32), guestPlatform: "windows-x64", imageDigest: `sha256:${"a".repeat(64)}`, resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };

test("reports Windows container provisioning failures instead of leaving the lease dispatched", async () => {
  const events: WorkerEvent[] = [];
  const driver = { createLease: async () => { throw new Error("provisioning exploded"); } };
  await runLeaseLifecycle(command, driver as never, bootstrap, event => events.push(event));
  expect(events).toEqual([expect.objectContaining({ type: "lease.failed", payload: expect.objectContaining({ commandId: command.id, leaseId, nonce: bootstrap.nonce, reason: "provisioning_failed" }) })]);
});
