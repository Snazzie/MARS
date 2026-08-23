import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerCacheProxy } from "@whitesmith/contracts";
import { encodeLinuxGuestMessage } from "../../orchestrator/src/linux-guest-protocol.ts";
import { runLinuxVirtioGuestStream } from "./linux-guest.ts";

const workerCache: WorkerCacheProxy = {
  proxyUrl: "http://127.0.0.1:39123",
  cacheBaseUrl: "https://127.0.0.1:39443",
  caCertificatePem: "-----BEGIN CERTIFICATE-----\nworker-ca\n-----END CERTIFICATE-----\n",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test("Linux guest runs official runner with credential-free worker cache transport", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "whitesmith-linux-guest-"));
  try {
    const output = join(root, "env");
    await writeFile(join(root, "run.sh"), `#!/bin/sh
printf '%s\n%s\n%s\n' "$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS" "$ACTIONS_RUNNER_INPUT_JITCONFIG" > '${output}'
test -s "$NODE_EXTRA_CA_CERTS"
`, { mode: 0o700 });
    await chmod(join(root, "run.sh"), 0o700);
    const envelope = {
      leaseId: "11111111-1111-4111-8111-111111111111",
      jobId: "22222222-2222-4222-8222-222222222222",
      nonce: "n".repeat(32),
      guestPlatform: "linux-x64" as const,
      encodedJitConfig: "jit-config",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      imageDigest: `repo@sha256:${"a".repeat(64)}`,
      resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 },
    };
    const channel = {
      readable: (async function* () { yield encodeLinuxGuestMessage({ type: "bootstrap", envelope }); })(),
      writes: [] as Uint8Array[],
      write(data: Uint8Array) { this.writes.push(data); },
      close() {},
    };
    const previousHttpsProxy = Bun.env.HTTPS_PROXY;
    Bun.env.HTTPS_PROXY = "ambient-proxy";
    try {
      await runLinuxVirtioGuestStream(channel, root, () => Date.now(), workerCache);
    } finally {
      if (previousHttpsProxy === undefined) delete Bun.env.HTTPS_PROXY;
      else Bun.env.HTTPS_PROXY = previousHttpsProxy;
    }
    const lines = (await Bun.file(output).text()).trim().split("\n");
    expect(lines[0]).toBe(workerCache.proxyUrl);
    expect(new URL(workerCache.proxyUrl).username).toBe("");
    expect(new URL(workerCache.proxyUrl).password).toBe("");
    expect(lines[2]).toBe("jit-config");
    expect(await Bun.file(lines[1]!).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
