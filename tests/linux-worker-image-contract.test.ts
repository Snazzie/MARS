import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("Linux broker is non-root and has only libvirt/qemu runtime dependencies", async () => {
  const dockerfile = await readFile("deploy/workers/linux-broker.Dockerfile", "utf8");
  expect(dockerfile).toContain("libvirt-clients");
  expect(dockerfile).toContain("qemu-utils");
  expect(dockerfile).toContain("USER whitesmith");
  expect(dockerfile).not.toContain("docker.sock");
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
