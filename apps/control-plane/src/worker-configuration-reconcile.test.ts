import { expect, test } from "bun:test";
import type { Sql } from "@whitesmith/db";
import { reconcileWorkerConfigurationOnConnect } from "./worker-requests.ts";

const desired = {
  appliance: { vcpu: 10, memoryBytes: 10 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 },
  runtime: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 },
  guestPlatforms: ["windows-x64"],
};

function database(rows: { desiredConfiguration: unknown; configurationRevision: string | null; appliedConfigurationRevision?: string | null; configurationCommandId: string | null }, command: unknown[] = []) {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const tx = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const query = strings.join(" ");
    const normalized = query.toLowerCase();
    queries.push(query);
    values.push(params);
    if (normalized.includes("desired_configuration as")) return [rows];
    if (normalized.includes("from commands") && normalized.includes("state in")) return command;
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, {
    begin: async (fn: (transaction: unknown) => unknown) => fn(tx),
  });
  return { db, queries, values };
}

test("restores ready state when the desired revision was already acknowledged", async () => {
  const revision = "a".repeat(64);
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const fixture = database(
    { desiredConfiguration: desired, configurationRevision: revision, appliedConfigurationRevision: revision, configurationCommandId: commandId },
    [{ id: commandId, state: "sent", payload: { revision } }],
  );
  await expect(reconcileWorkerConfigurationOnConnect(fixture.db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2"))
    .resolves.toEqual({ state: "ready", commandId });
  expect(fixture.queries.filter(query => query.includes("insert into commands"))).toHaveLength(0);
  expect(fixture.queries.some(query => query.includes("configuration_state='ready'"))).toBe(true);
});


test("creates one applying command from durable desired state after reconnect", async () => {
  const fixture = database({ desiredConfiguration: desired, configurationRevision: "a".repeat(64), configurationCommandId: null });
  const result = await reconcileWorkerConfigurationOnConnect(fixture.db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2");
  expect(result).toEqual({ state: "applying", commandId: expect.any(String) });
  expect(fixture.queries.some(query => query.includes("for update"))).toBe(true);
  expect(fixture.queries.some(query => query.includes("insert into commands"))).toBe(true);
  expect(fixture.values.flat()).toContain("worker.configure");
  expect(fixture.queries.some(query => query.includes("configuration_state='applying'"))).toBe(true);
});

test("reuses a pending command for the desired revision", async () => {
  const commandId = "b430a582-a516-48a6-abb9-72c1af04a8c3";
  const revision = "a".repeat(64);
  const fixture = database(
    { desiredConfiguration: desired, configurationRevision: revision, configurationCommandId: commandId },
    [{ id: commandId, state: "sent", payload: { revision } }],
  );
  await expect(reconcileWorkerConfigurationOnConnect(fixture.db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2"))
    .resolves.toEqual({ state: "applying", commandId });
  expect(fixture.queries.filter(query => query.includes("insert into commands"))).toHaveLength(0);
});

test("leaves a worker without desired state unconfigured", async () => {
  const fixture = database({ desiredConfiguration: null, configurationRevision: null, configurationCommandId: null });
  await expect(reconcileWorkerConfigurationOnConnect(fixture.db, "cbb0e9d8-23ff-480e-8465-408197c0c2d2"))
    .resolves.toEqual({ state: "unconfigured", commandId: null });
  expect(fixture.queries.some(query => query.includes("configuration_state='unconfigured'"))).toBe(true);
});
