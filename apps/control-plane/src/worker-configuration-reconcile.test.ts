import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { reconcileWorkerConfigurationOnConnect } from "./worker-requests.ts";

const desired = {
  appliance: { vcpu: 10, memoryBytes: 10 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 },
  runtime: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 },
  guestPlatforms: ["windows-x64"],
  selectedDriver: "windows-hyperv-container",
  cache: { ttlSeconds: 86400, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 },
};

function database(rows: { desiredConfiguration: unknown; configurationRevision: string | null; appliedConfigurationRevision?: string | null; configurationCommandId: string | null; configurationState?: string }, command: unknown[] = []) {
  return preparedTestDatabase(name => {
    if (name === "worker_request_connect_lock") return [rows];
    if (name === "worker_request_pending_config") return command;
    return [];
  });
}

test("replays the acknowledged configuration on every worker reconnect", async () => {
  const revision = "a".repeat(64);
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const db = database(
    { desiredConfiguration: desired, configurationRevision: revision, appliedConfigurationRevision: revision, configurationCommandId: commandId },
  );
  await expect(reconcileWorkerConfigurationOnConnect(db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2"))
    .resolves.toEqual({ state: "applying", commandId: expect.any(String) });
});

test("keeps an acknowledged configuration ready when the same Windows process reconnects", async () => {
  const revision = "a".repeat(64);
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const db = database({
    desiredConfiguration: desired, configurationRevision: revision,
    appliedConfigurationRevision: revision, configurationCommandId: commandId, configurationState: "ready",
  });
  expect(await reconcileWorkerConfigurationOnConnect(db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2", true))
    .toEqual({ state: "ready", commandId });
});

test("replays configuration on reconnect if it was not acknowledged", async () => {
  const revision = "a".repeat(64);
  const db = database({
    desiredConfiguration: desired, configurationRevision: revision,
    appliedConfigurationRevision: revision, configurationCommandId: null, configurationState: "error",
  });
  expect(await reconcileWorkerConfigurationOnConnect(db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2", true))
    .toEqual({ state: "applying", commandId: expect.any(String) });
});

test("creates one applying command from durable desired state after reconnect", async () => {
  const db = database({ desiredConfiguration: desired, configurationRevision: "a".repeat(64), configurationCommandId: null });
  const result = await reconcileWorkerConfigurationOnConnect(db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2");
  expect(result).toEqual({ state: "applying", commandId: expect.any(String) });
});

test("reuses a pending command for the desired revision", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const revision = "a".repeat(64);
  const db = database(
    { desiredConfiguration: desired, configurationRevision: revision, configurationCommandId: commandId },
    [{ id: commandId, payload: { workerId: "cbb0e9d8-23ff-480e-8465-408197c0c2d2", ...desired, revision, fingerprint: "b".repeat(64) } }],
  );
  await expect(reconcileWorkerConfigurationOnConnect(db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2"))
    .resolves.toEqual({ state: "applying", commandId });
});

test("leaves a worker without desired state unconfigured", async () => {
  const db = database({ desiredConfiguration: null, configurationRevision: null, configurationCommandId: null });
  await expect(reconcileWorkerConfigurationOnConnect(db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2"))
    .resolves.toEqual({ state: "unconfigured", commandId: null });
});


