import { describe, expect, test } from "bun:test";

describe("Windows container proof contract", () => {
  test("requires Hyper-V isolation and destructive cleanup", async () => {
    const proof = await Bun.file("deploy/workers/prove-windows-container.ps1").text();
    expect(proof).toContain("docker info");
    expect(proof).toContain("--isolation=hyperv");
    expect(proof).toContain("docker inspect");
    expect(proof).toContain("docker wait");
    expect(proof).toContain("docker rm -f");
    expect(proof).not.toContain("--isolation=process");
  });
});
