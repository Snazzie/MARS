import { describe, expect, test } from "bun:test";
import { buildMacWorkerJoinPayload } from "./mac-agent.ts";

describe("worker join payload", () => {
  test("allowlists identity fields and strips caller-supplied limits", () => {
    const payload = buildMacWorkerJoinPayload({ code: "A".repeat(43), publicKey: "ed25519", vmUuid: "vm-1", limits: { maxVcpuPerPod: 2 } } as never);
    expect("limits" in payload).toBe(false);
  });
  test("emits limit-free identity payload", () => {
    const payload = buildMacWorkerJoinPayload({ code: "A".repeat(43), publicKey: "ed25519", vmUuid: "vm-1" });
    expect(payload.platform).toBe("macos-arm64");
    expect(payload.vmUuid).toBe("vm-1");
  });
});
