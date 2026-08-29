import { describe, expect, test } from "bun:test";

const installer = await Bun.file("deploy/workers/install-worker.ps1").text();

describe("Windows worker-local image contract", () => {
  test("installer passes deferred image runtime configuration", () => {
    expect(installer).toContain("mars/windows-job:local");
    expect(installer).toContain("C:\\ProgramData\\Mars\\windows-job-image.json");
    expect(installer).toContain("MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST");
    expect(installer).toContain("MARS_ALLOW_LOCAL_CONTAINER_IMAGE=true");
    expect(installer).toContain("Assert-WindowsContainerHost");
    expect(installer).not.toContain("Build-LocalWindowsImage");
    expect(installer).not.toContain("Ensure-WindowsContainerRuntime");
  });

  test("manifest remains a worker-owned runtime contract", () => {
    expect(installer).not.toContain("schemaVersion");
    expect(installer).not.toContain("image ID mismatch");
  });
});
