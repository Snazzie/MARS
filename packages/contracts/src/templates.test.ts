import { describe, expect, test } from "bun:test";
import { TemplateManifest, WorkerTemplateSet, validateTemplateSet } from "./templates.ts";
const digest = "sha256:" + "a".repeat(64);
const manifest = (guestPlatform: "windows-x64" | "linux-x64") => ({ format: 1 as const, guestPlatform, source: { url: "https://vendor.example/template.vhdx", sha256: digest }, template: { sha256: digest, path: `${guestPlatform}.vhdx` }, hyperv: { generation: 2 as const, secureBoot: true, guestServiceInterface: true as const }, guestAgentVersion: "0.1.0", preparedAt: "2026-08-13T00:00:00.000Z" });
describe("Hyper-V template manifests", () => {
  test("accepts signed source and sealed Gen 2 template metadata", () => expect(TemplateManifest.parse(manifest("windows-x64")).guestPlatform).toBe("windows-x64"));
  test("rejects mutable or invalid template metadata", () => { expect(() => TemplateManifest.parse({ ...manifest("windows-x64"), template: { ...manifest("windows-x64").template, sha256: "latest" } })).toThrow(); expect(() => TemplateManifest.parse({ ...manifest("windows-x64"), hyperv: { generation: 1, secureBoot: true, guestServiceInterface: true } })).toThrow(); });
  test("rejects duplicate guest platforms", () => expect(() => WorkerTemplateSet.parse([manifest("windows-x64"), manifest("windows-x64")])).toThrow("duplicate"));
  test("rejects templates for non-Windows hosts", () => expect(() => validateTemplateSet("linux-x64", WorkerTemplateSet.parse([manifest("linux-x64")]))) .toThrow("incompatible"));
});
