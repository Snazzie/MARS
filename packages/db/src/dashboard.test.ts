import { expect, test } from "bun:test";
import { getOrganizationSettings } from "./dashboard.ts";

test("organization settings convert PostgreSQL numeric values to numbers", async () => {
  const db = (async () => [{
    organizationId: "org-1",
    maxVcpuPerPod: "4",
    maxMemoryBytesPerPod: "8589934592",
    maxStorageBytesPerPod: "107374182400",
    maxConcurrentPods: "2",
  }]) as never;

  const settings = await getOrganizationSettings(db, "org-1");

  expect(settings).toEqual({
    organizationId: "org-1",
    maxVcpuPerPod: 4,
    maxMemoryBytesPerPod: 8589934592,
    maxStorageBytesPerPod: 107374182400,
    maxConcurrentPods: 2,
  });
});
