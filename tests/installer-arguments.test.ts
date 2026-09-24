import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsInstallerValues } from "../apps/control-plane/src/http/worker-routes.ts";

const linux = await Bun.file("deploy/workers/install-worker.sh").text();
const linuxDockerfile = await Bun.file("deploy/workers/linux-broker.Dockerfile").text();
const compose = await Bun.file("deploy/workers/linux-broker-compose.yaml").text();
const windows = await Bun.file("deploy/workers/install-worker.ps1").text();
const windowsSchema5 = await Bun.file("tests/fixtures/install-worker-schema5.ps1").text();
const windowsBuilder = await Bun.file("deploy/workers/build-windows-container-image-local.ps1").text();
const mac = await Bun.file("deploy/workers/install-worker-macos.sh").text();
const macPreparation = await Bun.file("deploy/workers/prepare-tart-job-image.sh").text();
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
  expect(linux).toContain('IDENTITY_FILE="$CONFIG_DIR/worker-identity.json"');
  expect(linux).toContain('if [[ "$UPGRADE" -eq 1 && ! -s "$IDENTITY_FILE" ]]');
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

test("Windows installer supports container and VM runtimes with isolated prerequisites", () => {
  expect(windows).toContain("[ValidateSet('container','vm')]");
  expect(windows).toContain("WindowsCheckpointUrl");
  expect(windows).toContain("[ValidateSet('checkpoint','iso','vhdx')]");
  expect(windows).toContain("WindowsVmProvisionerUrl");
  expect(windows).toContain("MARS_WINDOWS_RUNTIME=$WindowsRuntime");
  expect(windows).toContain("if ($WindowsRuntime -eq 'vm')");
  expect(windows).toContain("Assert-HyperVHost");
  expect(windows).toContain("MARS_WINDOWS_CHECKPOINT_PATH=$checkpointPath");
  expect(windows).toContain("if ($WindowsRuntime -eq 'container')");
  for (const name of [
    "WindowsOrchestratorUrl", "WindowsServiceHostUrl", "WindowsJobAgentUrl", "WindowsContainerBaseImage",
    "WindowsRunnerUrl", "WindowsGitUrl", "WindowsVcRuntimeUrl",
    "WindowsVmProvisionerUrl", "WindowsContainerBuilderUrl", "WindowsContainerVerifierUrl", "WindowsContainerfileUrl", "WindowsContainerEntrypointUrl",
  ]) expect(windows).toContain(`$${name}`);
  expect(windows).toContain("Assert-ArtifactConfiguration");
  expect(windows).toContain("Download-Verified $WindowsContainerBuilderUrl");
  expect(windows).toContain("Download-Verified $WindowsCheckpointUrl");
  expect(windows).toContain("Verify-DownloadedFile");
  expect(windows).toContain("-ManifestPath $paths.manifest");
  expect(windows).toContain("Move-Item -LiteralPath $paths.manifest -Destination $windowsImageManifestPath -Force");
  expect(windows.indexOf("Move-Item -LiteralPath $paths.manifest")).toBeGreaterThan(windows.indexOf("if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $paths.manifest"));
  expect(windows).not.toContain("Remove-Item -LiteralPath $windowsImageManifestPath");
  expect(windows).toContain("Register-ResumeTask");
  expect(windows).toContain("'-WindowsTrayScriptUrl',$WindowsTrayScriptUrl,'-WindowsTrayScriptSha256',$WindowsTrayScriptSha256");
  expect(windows).toContain("Remove-ResumeTask");
  expect(windows).toContain("New-ScheduledTaskSettingsSet -RestartCount 120");
});
test("Windows installer allows container NAT traffic to the authenticated cache ports", () => {
  expect(windows).toContain("New-NetFirewallRule -DisplayName 'Mars Worker Cache'");
  expect(windows).toContain("-Profile Any -RemoteAddress LocalSubnet");
  expect(windows).toContain("http://host.docker.internal:8788");
  expect(windows).toContain("https://host.docker.internal:8789");
  expect(windows).not.toContain("docker.exe network inspect nat");
});
test("Windows installer configures repeated SCM recovery for freshly registered workers", () => {
  expect(windows).toContain("function Set-WorkerServiceRecovery");
  expect(windows).toContain("sc.exe failure MarsWorker 'reset= 86400' 'actions= restart/5000/restart/30000/restart/60000'");
  expect(windows).toContain("sc.exe failureflag MarsWorker 1");
  const helper = windows.indexOf("function Set-WorkerServiceRecovery");
  const registration = windows.lastIndexOf("Set-WorkerServiceRecovery");
  expect(registration).toBeGreaterThan(helper);
  expect(windows).not.toContain("'actions= restart/5000/restart/30000/none/0'");
});
test("Windows upgrade stages and transactionally rolls back every worker mutation", () => {
  expect(windows).toContain("function Invoke-WorkerUpgrade");
  const upgradeStart = windows.indexOf("function Invoke-WorkerUpgrade");
  const upgradeEnd = windows.indexOf("function Set-WorkerJoinCredential", upgradeStart);
  expect(upgradeStart).toBeGreaterThan(-1);
  expect(upgradeEnd).toBeGreaterThan(upgradeStart);
  const upgrade = windows.slice(upgradeStart, upgradeEnd);
  for (const artifact of [
    "Download-Verified $WindowsOrchestratorUrl",
    "Download-Verified $WindowsServiceHostUrl",
    "Download-Verified $WindowsVmProvisionerUrl",
    "Download-Verified $WindowsJobAgentUrl",
    "Stop-Service MarsWorker",
    "Start-Service MarsWorker",
    "mars-orchestrator.exe",
    "mars-service-host.exe",
  ]) expect(upgrade).toContain(artifact);
  expect(upgrade).not.toContain("Set-WorkerCacheFirewall");
  expect(upgrade).toContain("Invoke-MarsUpgradeFault 'after-health'");
  expect(upgrade).toContain("GetValueKind('Environment')");
  expect(upgrade).toContain("imageState=$imageStatePath");
  expect(upgrade).toContain("Copy-Item -LiteralPath (Join-Path $backup $entry.Key)");
  for (const forbidden of [
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
windowsRuntimeTest("Windows installer propagates configured container DNS servers into the service environment", async () => {
  const start = windows.indexOf("  $serviceEnvironment = @(");
  const end = windows.indexOf("\n  New-ItemProperty", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const serviceEnvironment = windows.slice(start, end);
  const runServiceEnvironment = async (dnsServers?: string) => {
    const dnsSetup = dnsServers === undefined
      ? "Remove-Item Env:MARS_WINDOWS_CONTAINER_DNS_SERVERS -ErrorAction SilentlyContinue"
      : `$env:MARS_WINDOWS_CONTAINER_DNS_SERVERS = '${dnsServers}'`;
    const script = `
$ControlPlaneUrl = 'https://control.example'
$JoinCodeFile = 'C:\\ProgramData\\Mars\\join-code'
$WindowsContainerImage = 'mars/windows-job:local'
$WindowsContainerPrefix = 'mars'
$WindowsContainerReadyTimeoutMs = 15000
$WindowsContainerJobTimeoutMs = 900000
$windowsImageManifestPath = 'C:\\ProgramData\\Mars\\windows-job-image.json'
$AllowLocalContainerImage = $false
foreach ($name in @('MARS_ACTION_CACHE_ROOT','MARS_CACHE_PROXY_PORT','MARS_CACHE_DATA_PORT','MARS_CACHE_PROXY_URL','MARS_CACHE_ADVERTISE_URL','MARS_CACHE_TOKEN_ISSUER','MARS_CACHE_JWKS_URL','MARS_WINDOWS_CONTAINER_DNS_SERVERS')) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
${dnsSetup}
$env:MARS_CACHE_PROXY_PORT = '9000'
${serviceEnvironment}
$serviceEnvironment | ConvertTo-Json -Compress
`;
    const process = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(0);
    return JSON.parse(await new Response(process.stdout).text()) as string[];
  };

  const configured = await runServiceEnvironment("10.36.172.244,10.36.172.245");
  expect(configured).toEqual(expect.arrayContaining([
    "MARS_CACHE_PROXY_PORT=9000",
    "MARS_WINDOWS_CONTAINER_DNS_SERVERS=10.36.172.244,10.36.172.245",
  ]));
  const unset = await runServiceEnvironment();
  expect(unset).toContain("MARS_CACHE_PROXY_PORT=9000");
  expect(unset).not.toContain(expect.stringContaining("MARS_WINDOWS_CONTAINER_DNS_SERVERS="));
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
    "MARS_ORCHESTRATOR_URL", "MARS_ORCHESTRATOR_SHA256", "MARS_MACOS_JOB_AGENT_URL", "MARS_MACOS_JOB_AGENT_SHA256",
    "MARS_LINUX_ARM64_JOB_AGENT_URL", "MARS_LINUX_ARM64_JOB_AGENT_SHA256", "MARS_LINUX_ARM64_RUNNER_URL", "MARS_LINUX_ARM64_RUNNER_SHA256",
    "IMAGE_PREPARATION_SCRIPT_URL", "IMAGE_PREPARATION_SCRIPT_SHA256", "TART_MACOS_IMAGE", "TART_LINUX_ARM64_IMAGE",
  ]) expect(mac).toContain(name);
  expect(mac).toContain("download_verified \"$MARS_ORCHESTRATOR_URL\"");
  expect(mac).toContain("download_verified \"$MARS_MACOS_JOB_AGENT_URL\"");
  expect(mac).toContain("download_verified \"$IMAGE_PREPARATION_SCRIPT_URL\"");
  expect(mac).toContain('--dump-header "$headers" --output "$destination" "$url"');
  expect(mac).toContain("chmod +x \"$ORCHESTRATOR_STAGE\" \"$MACOS_JOB_AGENT_STAGE\" \"$LINUX_JOB_AGENT_STAGE\"");
  expect(mac).toContain("--platform macos-arm64");
  expect(mac).toContain("--platform linux-arm64");
  expect(mac).toContain("MARS_TART_MACOS_BASE_IMAGE");
  expect(mac).toContain("MARS_TART_LINUX_ARM64_BASE_IMAGE");
  expect(macPreparation).toContain("--platform");
  expect(macPreparation).toContain("--runner-archive");
});


const macRuntimeTest = process.platform === "darwin" ? test : test.skip;
macRuntimeTest("macOS install and upgrade refresh images without replacing identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-mac-installer-"));
  const fakeBin = join(root, "bin");
  const appDir = join(root, "Library/Application Support/Mars");
  const launchAgents = join(root, "Library/LaunchAgents");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "join-code"), "OLD-CODE\n", { mode: 0o600 });
  await writeFile(join(appDir, "worker-identity.json"), '{"workerId":""}\n', { mode: 0o600 });

  const orchestrator = join(root, "orchestrator.payload");
  const jobAgent = join(root, "job-agent.payload");
  const preparer = join(root, "preparer.payload");
  await writeFile(orchestrator, "orchestrator payload\n");
  await writeFile(jobAgent, "job agent payload\n");
  await writeFile(preparer, `#!/bin/zsh
platform="macos-arm64"; manifest=""
while [[ $# -gt 0 ]]; do
  [[ "$1" == --platform ]] && platform="$2"
  [[ "$1" == --output-manifest ]] && manifest="$2"
  shift
done
printf '{"preparedDigest":"mars-%s-job@sha256:%s"}\n' "$platform" '${"b".repeat(64)}' > "$manifest"
`);
  for (const path of [orchestrator, jobAgent, preparer]) await chmod(path, 0o755);

  const hashOf = async (path: string) => new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");
  const hashes = await Promise.all([orchestrator, jobAgent, preparer].map(hashOf));
  const launchctlLog = join(root, "launchctl.log");
  const writeFake = async (name: string, body: string) => {
    const path = join(fakeBin, name);
    await writeFile(path, `#!/bin/zsh\n${body}\n`);
    await chmod(path, 0o755);
  };
  await writeFake("uname", '[[ "$1" == "-s" ]] && print Darwin || print arm64');
  await writeFake("sw_vers", 'print 14.0');
  await writeFake("sudo", '[[ "$1" == "-n" ]] && shift; exec "$@"');
  await writeFake("tart", '[[ "$1" == "--version" ]] && exit 0; exit 0');
  await writeFake("launchctl", 'print -r -- "$*" >> "$MARS_LAUNCHCTL_LOG"; exit 0');
  await writeFake("sips", 'out=""; while [[ $# -gt 0 ]]; do [[ "$1" == "--out" ]] && out="$2"; shift; done; print icon > "$out"');
  await writeFake("curl", `
output=""
url=""
for ((i=1; i<=$#; i++)); do
  [[ "\${@[$i]}" == "--output" || "\${@[$i]}" == "-o" ]] && output="\${@[$((i + 1))]}"
  url="\${@[$i]}"
done
if [[ -n "$output" ]]; then
  case "$output" in
    *mars-orchestrator) cp "$MARS_ORCHESTRATOR_PAYLOAD" "$output" ;;
    *mars-macos-job-agent|*mars-linux-arm64-job-agent|*runner.tar.gz) cp "$MARS_JOB_AGENT_PAYLOAD" "$output" ;;
    *prepare-tart-job-image.sh) cp "$MARS_PREPARER_PAYLOAD" "$output" ;;
    *mars-status-item) cp "$MARS_ORCHESTRATOR_PAYLOAD" "$output" ;;
    *.svg) print '<svg/>' > "$output" ;;
  esac
fi
`);

  const code = "N".repeat(43);
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    MARS_LAUNCHCTL_LOG: launchctlLog,
    MARS_ORCHESTRATOR_PAYLOAD: orchestrator,
    MARS_JOB_AGENT_PAYLOAD: jobAgent,
    MARS_PREPARER_PAYLOAD: preparer,
    PUBLIC_BASE_URL: "http://mars.test",
    MARS_ARTIFACT_MODE: "local",
    MARS_WORKER_VERSION: "1.0.0",
    MARS_WORKER_CONTRACT_VERSION: "0.3.0",
    MARS_ORCHESTRATOR_URL: "http://mars.test/orchestrator",
    MARS_ORCHESTRATOR_SHA256: hashes[0],
    MARS_MACOS_JOB_AGENT_URL: "http://mars.test/macos-job-agent",
    MARS_MACOS_JOB_AGENT_SHA256: hashes[1],
    MARS_LINUX_ARM64_JOB_AGENT_URL: "http://mars.test/linux-job-agent",
    MARS_LINUX_ARM64_JOB_AGENT_SHA256: hashes[1],
    MARS_LINUX_ARM64_RUNNER_URL: "http://mars.test/linux-runner",
    MARS_LINUX_ARM64_RUNNER_SHA256: hashes[1],
    IMAGE_PREPARATION_SCRIPT_URL: "http://mars.test/preparer",
    IMAGE_PREPARATION_SCRIPT_SHA256: hashes[2],
    MARS_MACOS_STATUS_ITEM_URL: "http://mars.test/status-item",
    MARS_MACOS_STATUS_ITEM_SHA256: hashes[0],
    TART_MACOS_IMAGE: `ghcr.io/mars/macos@sha256:${"c".repeat(64)}`,
    TART_LINUX_ARM64_IMAGE: `ghcr.io/mars/ubuntu@sha256:${"d".repeat(64)}`,
  };
  try {
    const child = Bun.spawn(["zsh", "deploy/workers/install-worker-macos.sh", "--code", code], {
      cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(await readFile(join(appDir, "join-code"), "utf8")).toBe(`${code}\n`);
    expect((await stat(join(appDir, "join-code"))).mode & 0o777).toBe(0o600);
    expect(await Bun.file(join(appDir, "worker-identity.json")).exists()).toBe(false);
    const events = (await readFile(launchctlLog, "utf8")).trim().split("\n");
    expect(events.findIndex(event => event.includes("bootout"))).toBeLessThan(events.findIndex(event => event.includes("bootstrap")));
    const identity = '{"workerId":"preserved-worker"}\n';
    const identityFile = join(appDir, "worker-identity.json");
    await writeFile(identityFile, identity, { mode: 0o600 });
    const upgrade = Bun.spawn(["zsh", "deploy/workers/install-worker-macos.sh", "--upgrade"], {
      cwd: process.cwd(), env: { ...env, MARS_WORKER_VERSION: "1.1.0" }, stdout: "pipe", stderr: "pipe",
    });
    const [upgradeExitCode, upgradeStdout, upgradeStderr] = await Promise.all([
      upgrade.exited, new Response(upgrade.stdout).text(), new Response(upgrade.stderr).text(),
    ]);
    expect(upgradeExitCode, `${upgradeStdout}\n${upgradeStderr}`).toBe(0);
    expect(await readFile(identityFile, "utf8")).toBe(identity);
    expect(await readFile(join(appDir, "join-code"), "utf8")).toBe(`${code}\n`);
    const launcher = await readFile(join(appDir, "run-worker.sh"), "utf8");
    expect(launcher).toContain("MARS_WORKER_VERSION=1.1.0");
    expect(launcher).toContain("MARS_TART_MACOS_IMAGE_DIGEST=");
    expect(launcher).toContain("MARS_TART_LINUX_ARM64_IMAGE_DIGEST=");
    expect(launcher).toContain("export MARS_JOIN_CODE_FILE=''");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Windows route values expose schema-6 shared and container assets through control-plane endpoints", () => {
  const asset = (suffix: string) => ({ url: `https://release.example/${suffix}`, sha256: hash });
  const values = windowsInstallerValues({
    installer: asset("install-worker.ps1"), orchestrator: asset("orchestrator.exe"), serviceHost: asset("service-host.exe"), jobAgent: asset("job-agent.exe"),
    runner: asset("runner.zip"), git: asset("git.zip"), vcRuntime: asset("vc.exe"),
    trayScript: asset("tray.ps1"),
    container: {
      baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
      buildScript: asset("builder.ps1"), verifyScript: asset("verify.ps1"), containerfile: asset("Containerfile"), entrypoint: asset("entrypoint.ps1"),
    },
  }, "https://control.example");
  expect(values).toMatchObject({
    WindowsRuntime: "container", WindowsOrchestratorSha256: hash, WindowsServiceHostSha256: hash, WindowsJobAgentSha256: hash,
    WindowsContainerBaseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
    WindowsRunnerSha256: hash, WindowsGitSha256: hash, WindowsVcRuntimeSha256: hash,
    WindowsContainerBuilderSha256: hash, WindowsContainerVerifierSha256: hash, WindowsContainerfileSha256: hash, WindowsContainerEntrypointSha256: hash,
  });
  for (const endpoint of ["orchestrator", "service-host", "windows-tray-script", "windows-job-agent", "windows-runner", "windows-git", "windows-vc-runtime", "windows-container-builder", "windows-container-verifier", "windows-containerfile", "windows-container-entrypoint"]) expect(JSON.stringify(values)).toContain(`https://control.example/api/workers/${endpoint}`);
});
test("Windows route values keep the Hyper-V checkpoint on upgrades", () => {
  const asset = (suffix: string) => ({ url: `https://release.example/${suffix}`, sha256: hash });
  const values = windowsInstallerValues({
    installer: asset("install-worker.ps1"),
    orchestrator: asset("orchestrator.exe"),
    serviceHost: asset("service-host.exe"),
    jobAgent: asset("job-agent.exe"),
    runner: asset("runner.zip"), git: asset("git.zip"), vcRuntime: asset("vc.exe"),
    trayScript: asset("tray.ps1"),
    vm: { checkpoint: asset("windows-worker-checkpoint.zip"), provisioner: asset("provisioner.zip") },
  }, "https://control.example", undefined, true, { releaseVersion: "1.0.0", contractVersion: "0.3.0" }, "vm");
  expect(values).toMatchObject({
    WindowsRuntime: "vm",
    WindowsCheckpointUrl: "https://control.example/api/workers/windows-vm-checkpoint",
    WindowsCheckpointSha256: hash,
  });
  expect(values).not.toHaveProperty("WindowsContainerBaseImage");
});

test("schema-5 installers retain legacy shared-asset parameter names", () => {
  const asset = (suffix: string) => ({ url: `https://release.example/${suffix}`, sha256: hash });
  const values = windowsInstallerValues({
    installer: asset("install-worker.ps1"), orchestrator: asset("orchestrator.exe"), serviceHost: asset("service-host.exe"), jobAgent: asset("job-agent.exe"),
    trayScript: asset("tray.ps1"),
    vm: { checkpoint: asset("checkpoint.zip") },
    container: {
      baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
      runner: asset("runner.zip"), git: asset("git.zip"), vcRuntime: asset("vc.exe"),
      buildScript: asset("builder.ps1"), verifyScript: asset("verify.ps1"), containerfile: asset("Containerfile"), entrypoint: asset("entrypoint.ps1"),
    },
  }, "https://control.example", undefined, false, { releaseVersion: "0.9.0", contractVersion: "0.3.0" }, "container", "checkpoint", 5);
  expect(values).toMatchObject({
    WindowsContainerRunnerSha256: hash,
    WindowsContainerGitSha256: hash,
    WindowsContainerVcRuntimeSha256: hash,
  });
  expect(values).not.toHaveProperty("WindowsRunnerSha256");
  expect(values.WindowsContainerRunnerUrl).toBe("https://control.example/api/workers/windows-runner");
});

test("schema-5 generated values fit the frozen published installer fixture", () => {
  const asset = (suffix: string) => ({ url: `https://release.example/${suffix}`, sha256: hash });
  const values = windowsInstallerValues({
    installer: asset("install.ps1"), orchestrator: asset("orchestrator.exe"), serviceHost: asset("host.exe"), jobAgent: asset("agent.exe"),
    vm: { checkpoint: asset("checkpoint.zip") },
    container: {
      baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
      runner: asset("runner.zip"), git: asset("git.zip"), vcRuntime: asset("vc.exe"),
      buildScript: asset("build.ps1"), verifyScript: asset("verify.ps1"), containerfile: asset("Containerfile"), entrypoint: asset("entrypoint.ps1"),
    },
  }, "https://control.example", undefined, false, { releaseVersion: "0.9.0", contractVersion: "0.3.0" }, "container", "checkpoint", 5);
  for (const name of Object.keys(values)) {
    if (["WorkerVersion", "WorkerContractVersion", "WindowsContainerImage"].includes(name)) continue;
    expect(windowsSchema5).toContain(`$${name}`);
  }
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
