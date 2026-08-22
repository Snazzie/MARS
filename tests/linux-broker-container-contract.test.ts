import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("broker compose mounts only declared worker resources", async () => {
  const compose = await readFile("deploy/workers/linux-broker-compose.yaml", "utf8");
  expect(compose).toContain("/var/run/libvirt/libvirt-sock");
  expect(compose).toContain("group_add:");
  expect(compose).toContain("golden:ro");
  expect(compose).not.toContain("/var/run/docker.sock");
  expect(compose).not.toContain("/:/host");
});

test("installer does not boot a job VM", async () => {
  const installer = await readFile("deploy/workers/install-worker.sh", "utf8");
  expect(installer).toContain("docker compose");
  expect(installer).toContain("no job VM was started");
  expect(installer).not.toMatch(/virsh\s+(define|start)/);
  expect(installer).toContain("cosign verify-blob");
});
