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

test("ARM64 broker passes the canonical digest-pinned job image variable", async () => {
  const compose = await readFile("deploy/workers/linux-arm64-broker-compose.yaml", "utf8");
  expect(compose).toContain("MARS_LINUX_ARM64_CONTAINER_IMAGE: ${MARS_JOB_IMAGE:?digest-pinned linux-arm64 job image required}");
  expect(compose).not.toContain("MARS_LINUX_CONTAINER_IMAGE");
});

test("installer starts the KVM-capable broker without signature prerequisites", async () => {
  const installer = await readFile("deploy/workers/install-worker.sh", "utf8");
  expect(installer).toContain("docker compose");
  expect(installer).toContain("no job VM was started");
  expect(installer).not.toMatch(/virsh\s+(define|start)/);
  expect(installer).not.toMatch(/cosign|signature|\.bundle/);
});
