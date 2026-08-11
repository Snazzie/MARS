import { describe, expect, test } from "bun:test";
import { buildMacWorkerJoinPayload } from "./mac-agent.ts";

describe("worker join payload", () => {
  test("macOS payload carries identity only and no limits", () => {
    const payload = buildMacWorkerJoinPayload({ code: "A".repeat(43), publicKey: "ed25519", vmUuid: "vm-1" });
    expect(payload).toEqual({ code: "A".repeat(43), publicKey: "ed25519", vmUuid: "vm-1", platform: "macos-arm64" });
    expect("limits" in payload).toBe(false);
  });
});
