import { expect, test } from "bun:test";
import { applyWorkerConfigurationAcknowledgement } from "./worker-requests.ts";

test("records the active desired configuration after an exact acknowledgement", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const revision = "a".repeat(64);
  const expected = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"] };
  const queries: string[] = [];
  const query = async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    queries.push(text);
    if (text.includes("configuration_revision as")) return [{ configurationRevision: revision, configurationCommandId: commandId, desiredConfiguration: expected }];
    if (text.includes("returning id")) return [{ id: workerId }];
    return [];
  };
  const db = Object.assign(query, { begin: async (fn: (tx: typeof query) => unknown) => fn(query) }) as never;
  const result = await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: expected } });
  expect(result).toBe(true);
  expect(queries.some(query => query.includes("applied_configuration_revision=configuration_revision"))).toBe(true);
  expect(queries.some(query => query.includes("configuration_applied_at=now()"))).toBe(true);
  expect(queries.some(query => query.includes("worker.configuration_applied"))).toBe(true);
  expect(queries.every(query => !query.includes("select payload from commands"))).toBe(true);
});

test("keeps the last applied configuration when the current acknowledgement mismatches", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const revision = "a".repeat(64);
  const desired = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"] };
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("configuration_revision as")) return [{ configurationRevision: revision, configurationCommandId: commandId, desiredConfiguration: desired }];
    return [];
  }) as never;
  const result = await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: { ...desired, appliance: { ...desired.appliance, vcpu: 1 } } } });
  expect(result).toBe(false);
  expect(queries.some(query => query.includes("configuration_state='error'") && query.includes("configuration_command_id="))).toBe(true);
  expect(queries.every(query => !query.includes("configuration_applied_at=now()"))).toBe(true);
});
