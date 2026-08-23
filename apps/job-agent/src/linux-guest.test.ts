import { expect, mock, test } from "bun:test";
import { encodeLinuxGuestMessage, LinuxGuestFrameParser } from "../../orchestrator/src/linux-guest-protocol.ts";
import { runLinuxVirtioGuestStream } from "./linux-guest.ts";

const leaseId = "11111111-1111-4111-8111-111111111111";
const envelope = {
  leaseId,
  jobId: "22222222-2222-4222-8222-222222222222",
  nonce: "n".repeat(32),
  guestPlatform: "linux-x64" as const,
  encodedJitConfig: "encoded-jit-config",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  imageDigest: "sha256:test",
  resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 },
};

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("emits runner.ready before starting the Linux runner", async () => {
  const events: string[] = [];
  const parser = new LinuxGuestFrameParser();
  const channel = {
    readable: (async function* () {
      yield encodeLinuxGuestMessage({ type: "bootstrap", envelope });
    })(),
    write(data: Uint8Array) {
      for (const message of parser.push(data)) events.push(message.type);
    },
    close() {
      events.push("channel.close");
    },
  };
  const spawn = mock(() => {
    events.push("runner.spawn");
    return {
      stdout: stream("runner started\n"),
      stderr: stream(""),
      exited: Promise.resolve(0),
    };
  });
  const originalSpawn = Bun.spawn;
  Bun.spawn = spawn as typeof Bun.spawn;
  try {
    await expect(runLinuxVirtioGuestStream(channel, "/runner", () => Date.now())).resolves.toBe(0);
  } finally {
    Bun.spawn = originalSpawn;
    spawn.mockRestore();
  }

  expect(events.slice(0, 3)).toEqual(["bootstrap.accepted", "runner.ready", "runner.spawn"]);
  expect(events).toContain("runner.finished");
});
