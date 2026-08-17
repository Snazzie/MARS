import { describe, expect, test } from "bun:test";

const installer = await Bun.file("deploy/workers/install-worker.ps1").text();

describe("Windows worker-local image contract", () => {
  test("installer exposes immutable image build inputs", () => {
    for (const name of [
      "WindowsContainerBaseImage",
      "WindowsContainerRunnerUrl",
      "WindowsContainerRunnerSha256",
      "WindowsContainerGitUrl",
      "WindowsContainerGitSha256",
      "WindowsContainerVcUrl",
      "WindowsContainerVcSha256",
    ]) expect(installer).toContain(name);
    expect(installer).toContain("https://");
    expect(installer).toContain("whitesmith/windows-job:local");
    expect(installer).toContain("C:\\ProgramData\\Whitesmith\\windows-job-image.json");
  });

  test("manifest contract names provenance and runtime evidence", () => {
    const fields = ["schemaVersion", "baseImage", "runnerSha256", "gitSha256", "vcRuntimeSha256", "jobAgentSha256", "image", "imageId", "runtimeProbe", "builtAt"];
    for (const field of fields) expect(installer).toContain(field);
    expect(installer).toContain("image ID mismatch");
    expect(installer).toContain("runtime probe");
  });
});
