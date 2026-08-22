import { RunnerJitConfig } from "@whitesmith/contracts";
import { LinuxGuestFrameParser, encodeLinuxGuestMessage, type LinuxGuestMessage } from "../../orchestrator/src/linux-guest-protocol.ts";

type Duplex = { readable: AsyncIterable<Uint8Array | string>; write(data: Uint8Array): void; close?: () => void };
export async function runLinuxVirtioGuestStream(channel: Duplex, runnerRoot: string, now = () => Date.now()): Promise<number> {
  const parser = new LinuxGuestFrameParser();
  let accepted = false;
  let leaseId = "";
  let nonce = "";
  let sequence = 0;
  for await (const chunk of channel.readable) {
    for (const message of parser.push(chunk)) {
      if (message.type !== "bootstrap") {
        if (accepted) throw new Error("linux_guest_duplicate_bootstrap");
        throw new Error("linux_guest_bootstrap_required");
      }
      if (accepted) throw new Error("linux_guest_duplicate_bootstrap");
      const envelope = message.envelope;
      if (envelope.guestPlatform !== "linux-x64" || Date.parse(envelope.expiresAt) <= now()) throw new Error("linux_guest_bootstrap_invalid");
      RunnerJitConfig.shape.encodedJitConfig.parse(envelope.encodedJitConfig);
      leaseId = envelope.leaseId; nonce = envelope.nonce; accepted = true;
      channel.write(encodeLinuxGuestMessage({ type: "bootstrap.accepted", leaseId, nonce }));
      channel.write(encodeLinuxGuestMessage({ type: "runner.ready", leaseId, nonce }));
      const proc = Bun.spawn(["./run.sh"], { cwd: runnerRoot, env: { ...Bun.env, ACTIONS_RUNNER_INPUT_JITCONFIG: envelope.encodedJitConfig }, stdout: "pipe", stderr: "pipe" });
      const output = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => { const reader = stream.getReader(); while (true) { const item = await reader.read(); if (item.done) break; const text = new TextDecoder().decode(item.value); channel.write(encodeLinuxGuestMessage({ type: "job.log", leaseId, stream: name, content: text.slice(0, 256 * 1024), sequence: sequence++ })); } };
      await Promise.all([output(proc.stdout, "stdout"), output(proc.stderr, "stderr")]);
      const exitCode = await proc.exited;
      channel.write(encodeLinuxGuestMessage({ type: "runner.finished", leaseId, nonce, exitCode: Math.max(0, exitCode) }));
      channel.close?.();
      return exitCode;
    }
  }
  parser.finish();
  throw new Error("linux_guest_channel_closed");
}

export async function runLinuxVirtioGuest(channelPath = "/dev/virtio-ports/org.whitesmith.bootstrap", runnerRoot = "/runner"): Promise<number> {
  const socket = await (Bun as unknown as { connect(options: unknown): Promise<Duplex> }).connect({ unix: channelPath });
  return runLinuxVirtioGuestStream(socket, runnerRoot);
}
