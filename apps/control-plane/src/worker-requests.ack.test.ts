import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { applyWorkerConfigurationAcknowledgement, applyWorkerConfigurationFailure } from "./worker-requests.ts";

test("records the active desired configuration after an exact acknowledgement", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const revision = "a".repeat(64);
  const expected = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"], selectedDriver: "tart-vm", cache: { ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
  const db = preparedTestDatabase(name => {
    if (name === "worker_request_applied_config") return [{ configurationRevision: revision, configurationCommandId: commandId, desiredConfiguration: expected }];
    if (name === "worker_request_config_ready") return [{ id: workerId }];
    return [];
  });
  const { cache: _cache, ...withoutCache } = expected;
  await expect(applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: withoutCache } })).resolves.toBe(false);
  await expect(applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: { ...withoutCache, cache: {} } } })).resolves.toBe(false);
  expect(await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: expected } })).toBe(true);
});
test("acknowledges a stale configuration command only when it belongs to this worker", async () => {
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const desiredCommandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const staleCommandId = "d430a582-a516-48a6-abb9-72c1af04a8c3";
  const revision = "a".repeat(64);
  const desired = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"], selectedDriver: "tart-vm", cache: { ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
  let staleCommandExists = true;
  const db = preparedTestDatabase(name => {
    if (name === "worker_request_applied_config") return [{ configurationRevision: revision, configurationCommandId: desiredCommandId, desiredConfiguration: desired }];
    if (name === "worker_request_prior_config_command") return staleCommandExists ? [{ id: staleCommandId }] : [];
    return [];
  });
  expect(await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId: staleCommandId, workerId, revision, observed: desired } })).toBe("stale");
  staleCommandExists = false;
  expect(await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId: crypto.randomUUID(), workerId, revision, observed: desired } })).toBe(false);
});

test("keeps the last applied configuration when the current acknowledgement mismatches", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const revision = "a".repeat(64);
  const desired = { appliance: { vcpu: 2, memoryBytes: 4, storageBytes: 8 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 }, guestPlatforms: ["macos-arm64"], selectedDriver: "tart-vm", cache: { ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
  const db = preparedTestDatabase(name => {
    if (name === "worker_request_applied_config") return [{ configurationRevision: revision, configurationCommandId: commandId, desiredConfiguration: desired }];
    return [];
  });
  const result = await applyWorkerConfigurationAcknowledgement(db, { workerId, payload: { commandId, workerId, revision, observed: { ...desired, cache: { ttlSeconds: 3600, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } } } });
  expect(result).toBe(false);
});

test("failed apply marks only the matching current command as error", async () => {
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const staleId = "d430a582-a516-48a6-abb9-72c1af04a8c3";
  const revision = "a".repeat(64);
  let state = "applying";
  const db = preparedTestDatabase((name, parameters) => {
    if (name === "worker_request_config_error" && parameters.commandId === commandId && parameters.revision === revision) {
      state = "error";
      return [{ id: workerId }];
    }
    if (name === "worker_request_prior_config_command") return [{ id: staleId }];
    return [];
  });
  const payload = { workerId, commandId, revision, reason: "Process isolation probe failed" };
  expect(await applyWorkerConfigurationFailure(db, { workerId, payload: { ...payload, commandId: staleId } })).toBe("stale");
  expect(state).toBe("applying");
  expect(await applyWorkerConfigurationFailure(db, { workerId, payload })).toBe(true);
  expect(state).toBe("error");
});
