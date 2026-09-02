import { expect, test } from "bun:test";
import { windowsInstallerValues } from "../apps/control-plane/src/http/worker-routes.ts";

const linux = await Bun.file("deploy/workers/install-worker.sh").text();
const linuxDockerfile = await Bun.file("deploy/workers/linux-broker.Dockerfile").text();
const compose = await Bun.file("deploy/workers/linux-broker-compose.yaml").text();
const windows = await Bun.file("deploy/workers/install-worker.ps1").text();
const windowsBuilder = await Bun.file("deploy/workers/build-windows-container-image-local.ps1").text();
const mac = await Bun.file("deploy/workers/install-worker-macos.sh").text();
const macPreparation = await Bun.file("deploy/workers/prepare-macos-job-image.sh").text();
const hash = "a".repeat(64);
const windowsRuntimeTest = process.platform === "win32" ? test : test.skip;

// Static assertions intentionally target the delivery contract, not incidental
// implementation details. Runtime execution belongs on the documented hosts.
test("Linux installer consumes and verifies all manifest-provided broker assets", () => {
  for (const name of [
    "MARS_ARTIFACT_MODE", "MARS_BROKER_IMAGE", "MARS_GOLDEN_IMAGE", "MARS_GOLDEN_DIGEST",
    "MARS_COMPOSE_FILE", "MARS_COMPOSE_SHA256", "MARS_DOMAIN_TEMPLATE", "MARS_DOMAIN_TEMPLATE_SHA256",
  ]) expect(linux).toContain(`${name} is required`);
  expect(linux).toContain('download_asset "$MARS_GOLDEN_IMAGE" "$MARS_GOLDEN_DIGEST"');
  expect(linux).toContain('download_asset "$MARS_COMPOSE_FILE" "$MARS_COMPOSE_SHA256"');
  expect(linux).toContain('download_asset "$MARS_DOMAIN_TEMPLATE" "$MARS_DOMAIN_TEMPLATE_SHA256"');
  expect(linux).toContain('[[ "$actual" == "$expected_hex" ]]');
  expect(linux).toContain("sha256sum");
  expect(linux).toContain("chown -R 10001:10001");
  expect(linux).toContain("ACTION_CACHE_ROOT");
  expect(linux.indexOf("download_verified")).toBeLessThan(linux.indexOf("docker compose"));
  expect(linux).toContain("Ubuntu 24.04");
  expect(linux).toContain("/dev/kvm is required");
});

test("Linux broker image and Compose preserve non-root writable paths and cache ports", () => {
  expect(linuxDockerfile).toContain("groupadd --gid 10001 mars");
  expect(linuxDockerfile).toContain("chown -R 10001:10001 /var/lib/mars");
  expect(linuxDockerfile).toContain("EXPOSE 8788 8789");
  expect(linuxDockerfile).toContain('ENTRYPOINT ["/usr/local/bin/mars-orchestrator", "linux-worker"]');
  for (const required of [
    "${MARS_CONTROL_PLANE_URL:?control-plane URL required}",
    "${MARS_GOLDEN_DIGEST:?golden image digest required}",
    "${MARS_LIBVIRT_NETWORK:?libvirt network required}",
    '${MARS_ACTION_CACHE_ROOT:?action cache directory required}:/var/lib/mars/action-cache',
    '${MARS_GOLDEN_ROOT:?golden directory required}:/var/lib/mars/golden:ro',
    '${MARS_DOMAIN_TEMPLATE:?domain template required}:/etc/mars/worker-domain.xml:ro',
    '"${MARS_CACHE_PROXY_PORT:-8788}:${MARS_CACHE_PROXY_PORT:-8788}"',
    '"${MARS_CACHE_DATA_PORT:-8789}:${MARS_CACHE_DATA_PORT:-8789}"',
  ]) expect(compose).toContain(required);
  expect(compose).toContain('user: "10001:10001"');
  expect(compose).toContain("MARS_JOIN_CODE_FILE: /var/lib/mars/config/join-code");
});

test("Windows installer is container-only and validates every immutable input before replacement", () => {
  expect(windows).toContain("[ValidateSet('container')]");
  expect(windows).not.toContain("WindowsTemplate");
  expect(windows).not.toContain("WindowsRuntime = 'vm'");
  for (const name of [
    "WindowsOrchestratorUrl", "WindowsServiceHostUrl", "WindowsJobAgentUrl", "WindowsContainerBaseImage",
    "WindowsContainerRunnerUrl", "WindowsContainerGitUrl", "WindowsContainerVcRuntimeUrl",
    "WindowsContainerBuilderUrl", "WindowsContainerVerifierUrl", "WindowsContainerfileUrl", "WindowsContainerEntrypointUrl",
  ]) expect(windows).toContain(`$${name}`);
  expect(windows).toContain("Assert-ArtifactConfiguration");
  expect(windows).toContain("Download-Verified $WindowsContainerBuilderUrl");
  expect(windows).toContain("Download-Verified $WindowsContainerfileUrl");
  expect(windows).toContain("Verify-DownloadedFile");
  expect(windows).toContain("-ManifestPath $paths.manifest");
  expect(windows).toContain("Move-Item -LiteralPath $paths.manifest -Destination $windowsImageManifestPath -Force");
  expect(windows.indexOf("Move-Item -LiteralPath $paths.manifest")).toBeGreaterThan(windows.indexOf("if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $paths.manifest"));
  expect(windows).not.toContain("Remove-Item -LiteralPath $windowsImageManifestPath");
  expect(windows).toContain("MARS_WINDOWS_RUNTIME=container");
  expect(windows).toContain("Register-ResumeTask");
  expect(windows).toContain("Remove-ResumeTask");
});
test("Windows upgrade path downloads only worker binaries and restarts the existing service", () => {
  expect(windows).toContain("function Invoke-WorkerUpgrade");
  const upgradeStart = windows.indexOf("function Invoke-WorkerUpgrade");
  const upgradeEnd = windows.indexOf("function Set-WorkerJoinCredential", upgradeStart);
  expect(upgradeStart).toBeGreaterThan(-1);
  expect(upgradeEnd).toBeGreaterThan(upgradeStart);
  const upgrade = windows.slice(upgradeStart, upgradeEnd);
  for (const artifact of [
    "Download-Verified $WindowsOrchestratorUrl",
    "Download-Verified $WindowsServiceHostUrl",
    "Stop-Service MarsWorker",
    "Start-Service MarsWorker",
    "mars-orchestrator.exe",
    "mars-service-host.exe",
  ]) expect(upgrade).toContain(artifact);
  for (const forbidden of [
    "WindowsJobAgentUrl",
    "WindowsContainerRunnerUrl",
    "WindowsContainerGitUrl",
    "WindowsContainerBuilderUrl",
    "Install-DockerDesktop",
    "Ensure-ContainerFeatures",
    "Set-WorkerJoinCredential",
    "Reset-WorkerIdentity",
    "New-Service",
    "sc.exe delete",
    "docker build",
    "windowsImageManifestPath",
  ]) expect(upgrade).not.toContain(forbidden);
  expect(windows).toContain("if ($Upgrade) {");
  expect(windows.indexOf("if ($Upgrade) {")).toBeLessThan(windows.indexOf("Download-Verified $WindowsJobAgentUrl"));
});


test("Windows local image builder accepts staged verified assets and stays local", () => {
  expect(windowsBuilder).toContain("RunnerArchivePath");
  expect(windowsBuilder).toContain("GitArchivePath");
  expect(windowsBuilder).toContain("VcRuntimePath");
  expect(windowsBuilder).toContain("Stage-Verified");
  expect(windowsBuilder).toContain("docker pull");
  expect(windowsBuilder).toContain("docker build");
  expect(windowsBuilder).not.toContain("docker push");
  expect(windowsBuilder).toContain("Windows image entrypoint is invalid");
});

test("macOS installer consumes verified routes and only configures LaunchAgent after local preparation", () => {
  for (const name of [
    "MARS_ORCHESTRATOR_URL", "MARS_ORCHESTRATOR_SHA256", "MARS_JOB_AGENT_URL", "MARS_JOB_AGENT_SHA256",
    "IMAGE_PREPARATION_SCRIPT_URL", "IMAGE_PREPARATION_SCRIPT_SHA256", "TART_IMAGE",
  ]) expect(mac).toContain(name);
  expect(mac).toContain("download_verified \"$MARS_ORCHESTRATOR_URL\"");
  expect(mac).toContain("download_verified \"$MARS_JOB_AGENT_URL\"");
  expect(mac).toContain("download_verified \"$IMAGE_PREPARATION_SCRIPT_URL\"");
  expect(mac).toContain("chmod +x \"$ORCHESTRATOR_STAGE\" \"$JOB_AGENT_STAGE\" \"$PREPARER_STAGE\"");
  expect(mac).toContain("TART_BIN=\"$TART_BIN\" \"$PREPARER_STAGE\"");
  expect(mac).toContain("LOCAL_IMAGE=\"mars-worker-base-${TART_IMAGE_DIGEST#sha256:}\"");
  expect(mac).toContain("mv -f \"$PLIST_TMP\" \"$PLIST\"");
  expect(mac).not.toContain('\"$TART_BIN\" clone');
  expect(mac).toContain("MARS_TART_BASE_IMAGE");
  expect(mac).toContain("MARS_TART_IMAGE_DIGEST");
});

test("macOS preparation is digest-pinned, content-addressed, reusable, and transactional", () => {
  expect(macPreparation).toContain("--output-manifest");
  expect(macPreparation).toContain("source must be a full lowercase digest-pinned OCI reference");
  expect(macPreparation).toContain("PREPARATION_SCRIPT_SHA256");
  expect(macPreparation).toContain("preparedDigest");
  expect(macPreparation).toContain("local_target_exists");
  expect(macPreparation).toContain("STAGING_TARGET");
  expect(macPreparation).toContain("tart rename");
  expect(macPreparation).toContain("tart delete \"$STAGING_TARGET\"");
  expect(macPreparation).toContain("EXPECTED_MANIFEST");
  expect(macPreparation).not.toContain("TART_REGISTRY_PASSWORD");
});

test("Windows route values expose every schema-3 container asset through control-plane endpoints", () => {
  const asset = (suffix: string) => ({ url: `https://release.example/${suffix}`, sha256: hash });
  const values = windowsInstallerValues({
    installer: asset("install-worker.ps1"), orchestrator: asset("orchestrator.exe"), serviceHost: asset("service-host.exe"), jobAgent: asset("job-agent.exe"),
    container: {
      baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
      runner: asset("runner.zip"), git: asset("git.zip"), vcRuntime: asset("vc.exe"), buildScript: asset("builder.ps1"),
      verifyScript: asset("verify.ps1"), containerfile: asset("Containerfile"), entrypoint: asset("entrypoint.ps1"),
    },
  }, "https://control.example");
  expect(values).toMatchObject({
    WindowsRuntime: "container", WindowsOrchestratorSha256: hash, WindowsServiceHostSha256: hash, WindowsJobAgentSha256: hash,
    WindowsContainerBaseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
    WindowsContainerRunnerSha256: hash, WindowsContainerGitSha256: hash, WindowsContainerVcRuntimeSha256: hash,
    WindowsContainerBuilderSha256: hash, WindowsContainerVerifierSha256: hash, WindowsContainerfileSha256: hash, WindowsContainerEntrypointSha256: hash,
  });
  for (const endpoint of ["orchestrator", "service-host", "windows-container-job-agent", "windows-container-runner", "windows-container-git", "windows-container-vc-runtime", "windows-container-builder", "windows-container-verifier", "windows-containerfile", "windows-container-entrypoint"]) expect(JSON.stringify(values)).toContain(`https://control.example/api/workers/${endpoint}`);
});

test("target-host installers are self-contained and contain no mutable release fallback", () => {
  for (const source of [linux, windows, mac]) {
    expect(source).not.toContain("releases/latest");
    expect(source).not.toContain("worker-release-manifest.json");
    expect(source).not.toMatch(/__[A-Za-z0-9_]+__/);
  }
});
windowsRuntimeTest("Windows downloaded-file verifier accepts exact bytes and rejects mismatches", async () => {
  const start = windows.indexOf("function Assert-Sha256");
  const end = windows.indexOf("\nfunction Download-Verified", start);
  const functions = windows.slice(start, end);
  const script = `${functions}
$path = Join-Path $env:TEMP ('mars-verify-' + [guid]::NewGuid().ToString('N'))
try {
  [IO.File]::WriteAllText($path, 'payload')
  $expected = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  Verify-DownloadedFile $path $expected 'payload' $null
  try { Verify-DownloadedFile $path ('b' * 64) 'payload' $null; throw 'mismatch accepted' } catch { if ($_.Exception.Message -notlike '*checksum mismatch*') { throw } }
  Write-Output 'VERIFIER_OK'
} finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
`;
  const process = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(0);
  expect(await new Response(process.stdout).text()).toContain("VERIFIER_OK");
});
windowsRuntimeTest("Windows image build failure raises the intended error", async () => {
  const failureLine = windows.split(/\r?\n/).find(line => line.includes("Windows job image build failed with exit code"));
  expect(failureLine).toBeDefined();
  const script = `$LASTEXITCODE = 23
$paths = @{ manifest = Join-Path $env:TEMP 'mars-missing-image-manifest.json' }
try {
${failureLine}
  throw 'build failure was swallowed'
} catch {
  if ($_.Exception.Message -notlike '*Windows job image build failed with exit code 23*') { throw }
  Write-Output 'BUILD_FAILURE_OK'
}`;
  const process = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(0);
  expect(await new Response(process.stdout).text()).toContain("BUILD_FAILURE_OK");
});
