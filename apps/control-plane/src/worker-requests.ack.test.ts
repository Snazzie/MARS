import { expect, test } from "bun:test";
import { applyWorkerConfigurationAcknowledgement, applyWorkerConfigurationFailure } from "./worker-requests.ts";

test("records the active desired configuration after an exact acknowledgement", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const revision = "a".repeat(64);
  const expected = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"], selectedDriver: "tart-vm", cache: { ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
  const queries: string[] = [];
  const query = async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    queries.push(text);
    if (text.includes("configuration_revision as")) return [{ configurationRevision: revision, configurationCommandId: commandId, desiredConfiguration: expected }];
    if (text.includes("returning id")) return [{ id: workerId }];
    return [];
  };
  const db = Object.assign(query, { begin: async (fn: (tx: typeof query) => unknown) => fn(query) }) as never;
  const { cache: _cache, ...withoutCache } = expected;
  await expect(applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: withoutCache } })).resolves.toBe(false);
  await expect(applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: { ...withoutCache, cache: {} } } })).resolves.toBe(false);
  const result = await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: expected } });
  expect(result).toBe(true);
  expect(queries.some(query => query.includes("applied_configuration_revision=configuration_revision"))).toBe(true);
  expect(queries.some(query => query.includes("configuration_applied_at=now()"))).toBe(true);
  expect(queries.some(query => query.includes("worker.configuration_applied"))).toBe(true);
  expect(queries.every(query => !query.includes("select payload from commands"))).toBe(true);
});
test("acknowledges a stale configuration command only when it belongs to this worker", async () => {
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const desiredCommandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const staleCommandId = "d430a582-a516-48a6-abb9-72c1af04a8c3";
  const revision = "a".repeat(64);
  const desired = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"], selectedDriver: "tart-vm", cache: { ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
  let staleCommandExists = true;
  const query = async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    if (text.includes("configuration_revision as")) return [{ configurationRevision: revision, configurationCommandId: desiredCommandId, desiredConfiguration: desired }];
    if (text.includes("select id from commands")) return staleCommandExists ? [{ id: staleCommandId }] : [];
    return [];
  };
  const db = Object.assign(query, {}) as never;
  expect(await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId: staleCommandId, workerId, revision, observed: desired } })).toBe("stale");
  staleCommandExists = false;
  expect(await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId: crypto.randomUUID(), workerId, revision, observed: desired } })).toBe(false);
});

test("keeps the last applied configuration when the current acknowledgement mismatches", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const revision = "a".repeat(64);
  const desired = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"], selectedDriver: "tart-vm", cache: { ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("configuration_revision as")) return [{ configurationRevision: revision, configurationCommandId: commandId, desiredConfiguration: desired }];
    return [];
  }) as never;
  const result = await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: { ...desired, cache: { ttlSeconds: 3600, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } } } });
  expect(result).toBe(false);
  expect(queries.some(query => query.includes("configuration_state='error'") && query.includes("configuration_command_id="))).toBe(true);
  expect(queries.every(query => !query.includes("configuration_applied_at=now()"))).toBe(true);
});

test("failed apply marks only the matching current command as error", async () => {
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const staleId = "d430a582-a516-48a6-abb9-72c1af04a8c3";
  const revision = "a".repeat(64);
  let state = "applying";
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    if (sql.includes("update workers set configuration_state='error'")) {
      if (values[1] === commandId && values[2] === revision) {
        state = "error";
        return [{ id: workerId }];
      }
      return [];
    }
    if (sql.includes("select id from commands")) return values[0] === staleId ? [{ id: staleId }] : [];
    return [];
  };
  const db = Object.assign(query, { begin: async (fn: (tx: typeof query) => unknown) => fn(query) }) as never;
  const payload = { workerId, commandId, revision, reason: "Process isolation probe failed" };
  expect(await applyWorkerConfigurationFailure(db, { workerId, payload: { ...payload, commandId: staleId } })).toBe("stale");
  expect(state).toBe("applying");
  expect(await applyWorkerConfigurationFailure(db, { workerId, payload })).toBe(true);
  expect(state).toBe("error");
});
