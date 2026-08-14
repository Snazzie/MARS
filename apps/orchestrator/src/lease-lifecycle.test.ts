import { expect, test } from "bun:test";
import type { LeaseBootstrapEnvelope, WorkerCommand } from "@whitesmith/contracts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";

const command = { version: 1, id: "33333333-3333-4333-8333-333333333333", type: "windows-container.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: "22222222-2222-4222-8222-222222222222", occurredAt: new Date().toISOString(), payload: {} } satisfies WorkerCommand;
const bootstrap = { leaseId: command.leaseId!, jobId: command.leaseId!, nonce: "n".repeat(32), guestPlatform: "windows-x64", imageDigest: `repo@sha256:${"a".repeat(64)}`, resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() } satisfies LeaseBootstrapEnvelope;

test("cleanup still removes a lease after stop failure", async () => {
  const events: string[] = [];
  let removed = false;
  const driver = { createLease: async () => ({ runtimeInstanceId: "runtime", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, completion: Promise.resolve(0), state: "sandbox_attested" as const }), stopLease: async () => { throw new Error("stop"); }, removeLease: async () => { removed = true; } };
  await runLeaseLifecycle(command, driver, bootstrap, event => events.push(event.type));
  expect(removed).toBe(true);
  expect(events).toEqual(["sandbox_attested", "runner.finished", "lease.failed"]);
});
