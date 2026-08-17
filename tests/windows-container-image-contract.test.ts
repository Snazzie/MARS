import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const script = await readFile("deploy/workers/build-windows-container-image.ps1", "utf8");
const containerfile = await readFile("images/jobs/windows/Containerfile", "utf8");
const entrypoint = await readFile("images/jobs/windows/entrypoint.ps1", "utf8");
const verifier = await readFile("images/jobs/windows/verify-runtime.ps1", "utf8");

describe("Windows job image contract", () => {
  test("pins the full Windows Server LTSC 2025 base and stages runtime verification", () => {
    expect(script).toContain("mcr\\.microsoft\\.com/windows/server:ltsc2025@sha256:");
    expect(script).toContain("BaseImage must be a digest-pinned mcr.microsoft.com/windows/server:ltsc2025 reference");
    expect(script).toContain("verify-runtime.ps1");
    expect(containerfile).toContain("Install-WindowsFeature -Name Server-Media-Foundation");
    expect(containerfile).toContain("RestartNeeded");
    expect(containerfile).toContain("verify-runtime.ps1");
    expect(containerfile).toContain("C:/Whitesmith/verify-runtime.ps1");
  });
  test("verifies Playwright Media Foundation and network prerequisites", () => {
    for (const name of ["mf.dll", "mfplat.dll", "msmpeg2vdec.dll", "evr.dll", "avrt.dll"]) {
      expect(verifier).toContain(name);
    }
    expect(verifier).toContain("param(");
    expect(verifier).toContain("[switch]$RequireNetwork");
    expect(verifier).toContain("Container DNS probe failed for api.github.com");
    expect(verifier).toContain("Container TCP probe failed for api.github.com:443");
    expect(verifier).toContain("TcpClient");
    expect(verifier).toContain("Dispose()");
  });

  test("pins inputs and emits a registry digest", () => {
    expect(script).toContain("@sha256:");
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("docker push");
    expect(script).toContain("RepoDigests");
    expect(containerfile).toContain("whitesmith-job-agent.exe");
    expect(containerfile).toContain("entrypoint.ps1");
  });

  test("rejects Server Core and arbitrary base images", () => {
    expect(script).toContain("server:ltsc2025@sha256:[0-9a-f]{64}");
    expect(script).not.toContain("^[^@\\s]+@sha256:[0-9a-f]{64}$");
  });

  test("provisions a hash-verified Git client", () => {
    expect(script).toContain("$GitArchive");
    expect(script).toContain("$GitSha256");
    expect(script).toContain("Git archive hash mismatch");
    expect(script).toContain("'git.zip'");
    expect(containerfile).toContain("COPY git.zip C:/temp/git.zip");
    expect(containerfile).toContain("Expand-Archive C:/temp/git.zip C:/Git");
    expect(containerfile).toContain("git.exe config --system core.autocrlf false");
    expect(entrypoint).toContain("$env:PATH = 'C:\\Git\\cmd;C:\\Git\\bin;' + $env:PATH");
    expect(script).toContain("$VcRuntimeInstaller");
    expect(script).toContain("$VcRuntimeSha256");
    expect(script).toContain("VC runtime installer hash mismatch");
    expect(script).toContain("'vc_redist.x64.exe'");
    expect(containerfile).toContain("COPY vc_redist.x64.exe C:/temp/vc_redist.x64.exe");
    expect(containerfile).toContain("Start-Process C:/temp/vc_redist.x64.exe");
  });
});
