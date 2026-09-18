import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("Linux broker is non-root and has only libvirt/qemu runtime dependencies", async () => {
  const dockerfile = await readFile("deploy/workers/linux-broker.Dockerfile", "utf8");
  expect(dockerfile).toContain("libvirt-clients");
  expect(dockerfile).toContain("qemu-utils");
  expect(dockerfile).toContain("USER mars");
  expect(dockerfile).not.toContain("docker.sock");
});
test("ARM64 broker installs Docker Compose v2 from the Docker repository", async () => {
  const dockerfile = await readFile("deploy/workers/linux-arm64-broker.Dockerfile", "utf8");
  expect(dockerfile).toContain("download.docker.com/linux/debian/gpg");
  expect(dockerfile).toContain("docker-ce-cli docker-compose-plugin");
  expect(dockerfile).toContain("linux-container-worker");
});

test("golden appliance contract is immutable and secret-free", async () => {
  const readme = await readFile("images/worker-appliance/README.txt", "utf8");
  const build = await readFile("images/worker-appliance/build.sh", "utf8");
  expect(readme).toContain("virtio-serial");
  expect(readme).not.toContain("K3s");
  expect(readme).not.toContain("Kata");
  expect(build).toContain("truncate -s 0 /etc/machine-id");
  expect(build).toContain("qemu-img check");
});
