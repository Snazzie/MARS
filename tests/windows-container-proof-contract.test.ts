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

  test("proves runtime prerequisites before leasing", async () => {
    const proof = await Bun.file("deploy/workers/prove-windows-container.ps1").text();
    expect(proof).toContain("verify-runtime.ps1");
    expect(proof).toContain("-RequireNetwork");
    expect(proof).toContain("runtimePrerequisitesVerified");
    expect(proof).toContain("runtimeProbe");
    expect(proof).toContain("docker logs");
  });
});
