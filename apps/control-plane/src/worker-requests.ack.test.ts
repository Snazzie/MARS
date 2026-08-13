import { expect, test } from "bun:test";
import { applyWorkerConfigurationAcknowledgement } from "./worker-requests.ts";

test("marks the active worker configuration ready after an exact acknowledgement", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const revision = "a".repeat(64);
  const expected = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 } };
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("configuration_revision as")) return [{ configurationRevision: revision, configurationCommandId: commandId }];
    if (query.includes("select payload from commands")) return [{ payload: { ...expected, revision } }];
    return [];
  }) as never;
  const result = await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: expected } });
  expect(result).toBe(true);
  expect(queries.some((query) => query.includes("set configuration_state='ready'"))).toBe(true);
});
