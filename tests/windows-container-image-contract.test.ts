import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const script = await readFile("deploy/workers/build-windows-container-image.ps1", "utf8");
const containerfile = await readFile("images/jobs/windows/Containerfile", "utf8");

describe("Windows job image contract", () => {
  test("pins inputs and emits a registry digest", () => {
    expect(script).toContain("@sha256:");
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("docker push");
    expect(script).toContain("RepoDigests");
    expect(containerfile).toContain("whitesmith-job-agent.exe");
    expect(containerfile).toContain("entrypoint.ps1");
  });
});
