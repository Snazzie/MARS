import { LeaseBootstrapEnvelope } from "@whitesmith/contracts";
import { z } from "zod";

export const MAX_LINUX_GUEST_FRAME = 1024 * 1024;
export const LinuxGuestMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bootstrap"), envelope: LeaseBootstrapEnvelope }).strict(),
  z.object({ type: z.literal("bootstrap.accepted"), leaseId: z.string().uuid(), nonce: z.string().min(1) }).strict(),
  z.object({ type: z.literal("runner.ready"), leaseId: z.string().uuid(), nonce: z.string().min(1) }).strict(),
  z.object({ type: z.literal("job.log"), leaseId: z.string().uuid(), stream: z.enum(["stdout", "stderr"]), content: z.string().max(256 * 1024), sequence: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("runner.finished"), leaseId: z.string().uuid(), nonce: z.string().min(1), exitCode: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("lease.failed"), leaseId: z.string().uuid(), nonce: z.string().min(1), reason: z.string().min(1).max(1024) }).strict(),
]);
export type LinuxGuestMessage = z.infer<typeof LinuxGuestMessage>;

export function encodeLinuxGuestMessage(message: LinuxGuestMessage): Uint8Array {
  const frame = new TextEncoder().encode(JSON.stringify(LinuxGuestMessage.parse(message)) + "\n");
  if (frame.byteLength > MAX_LINUX_GUEST_FRAME) throw new Error("linux_guest_frame_oversize");
  return frame;
}

export class LinuxGuestFrameParser {
  #buffer = "";
  push(chunk: string | Uint8Array): LinuxGuestMessage[] {
    this.#buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
    if (new TextEncoder().encode(this.#buffer).byteLength > MAX_LINUX_GUEST_FRAME) throw new Error("linux_guest_frame_oversize");
    const messages: LinuxGuestMessage[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) throw new Error("linux_guest_frame_empty");
      const message = LinuxGuestMessage.parse(JSON.parse(line));
      if (new TextEncoder().encode(line + "\n").byteLength > MAX_LINUX_GUEST_FRAME) throw new Error("linux_guest_frame_oversize");
      messages.push(message);
      newline = this.#buffer.indexOf("\n");
    }
    return messages;
  }
  finish(): void { if (this.#buffer.length) throw new Error("linux_guest_frame_truncated"); }
}
