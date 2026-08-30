import { expect, test } from "bun:test";
import { windowsInstallerValues } from "../apps/control-plane/src/http/worker-routes.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");
const linux = join(root, "deploy/workers/install-worker.sh");
const mac = join(root, "deploy/workers/install-worker-macos.sh");
const prepareMacImage = join(root, "deploy/workers/prepare-macos-job-image.sh");
const powershell = join(root, "deploy/workers/install-worker.ps1");
const linuxCompose = join(root, "deploy/workers/linux-broker-compose.yaml");
const prepareWindowsTemplate = join(root, "deploy/workers/prepare-windows-hyperv-template.ps1");
const valid = "A".repeat(43);
const posixRuntimeTest = process.platform === "win32" ? test.skip : test;
const macosRuntimeTest = process.platform === "darwin" ? test : test.skip;
const windowsRuntimeTest = process.platform === "win32" ? test : test.skip;

async function invoke(script: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(script.endsWith(".sh") ? [script, ...args] : ["zsh", script, ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

async function invokeLinuxUrlValidation(
  raw: string,
  name: string,
  kind: "origin" | "asset",
  mode: "local" | "production",
  baseUrl: string,
) {
  const source = await Bun.file(linux).text();
  const validator = source.match(/validate_url\(\) \{\r?\n\s+python3 [^\n]+ <<'PY'\r?\n([\s\S]*?)\r?\nPY\r?\n\}/)?.[1];
  if (!validator) throw new Error("Linux URL validator not found");
  const proc = Bun.spawn(
    [process.platform === "win32" ? "python" : "python3", "-c", validator, raw, name, kind, baseUrl],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MARS_ARTIFACT_MODE: mode, PUBLIC_BASE_URL: baseUrl },
    },
  );
  return {
    exitCode: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

async function invokePosixConfigValidation(script: string, env: Record<string, string>) {
  const source = await Bun.file(script).text();
  const cutoff = script === linux ? source.indexOf("\npreflight() {") : source.indexOf("\nvalidate_config\n");
  if (cutoff < 0) throw new Error("installer validation boundary not found");
  const tempDir = await mkdtemp(join(tmpdir(), "mars-installer-config-"));
  const harness = join(tempDir, script === linux ? "validate-linux.sh" : "validate-macos.sh");
  await Bun.write(harness, `${source.slice(0, cutoff)}\nvalidate_config\n`);
  try {
    const proc = Bun.spawn(
      [script === linux ? "bash" : "zsh", harness, "--code", valid, "--control-plane-url", env.PUBLIC_BASE_URL],
      { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } },
    );
    return {
      exitCode: await proc.exited,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function posixArtifactEnv(script: string, mode: "local" | "production", baseUrl: string, assetBaseUrl = baseUrl) {
  const hash = "a".repeat(64);
  if (script === mac) {
    return {
      PUBLIC_BASE_URL: baseUrl,
      MARS_ARTIFACT_MODE: mode,
      MARS_ORCHESTRATOR_SHA256: hash,
      TART_IMAGE: mode === "production" ? `ghcr.io/example/mars-worker@sha256:${hash}` : "mars-worker-local",
      TART_IMAGE_DIGEST: `sha256:${hash}`,
    };
  }
  return {
    PUBLIC_BASE_URL: baseUrl,
    MARS_ARTIFACT_MODE: mode,
    MARS_BROKER_IMAGE: mode === "production" ? `ghcr.io/example/mars-broker@sha256:${hash}` : "mars-broker:local",
    MARS_GOLDEN_IMAGE: `${assetBaseUrl}/api/workers/templates/linux-x64/artifact`,
    MARS_GOLDEN_DIGEST: `sha256:${hash}`,
    MARS_COMPOSE_FILE: `${assetBaseUrl}/api/workers/artifacts/linux-broker-compose`,
    MARS_COMPOSE_SHA256: hash,
    MARS_DOMAIN_TEMPLATE: `${assetBaseUrl}/api/workers/artifacts/linux-domain-template`,
    MARS_DOMAIN_TEMPLATE_SHA256: hash,
  };
}

async function invokeWindowsPreflight(source: string, scenario: "active-hypervisor" | "missing-firmware" | "bare-metal-no-slat") {
  const tempDir = await mkdtemp(join(tmpdir(), "mars-installer-preflight-"));
  const scriptPath = join(tempDir, "preflight.ps1");
  const stageMarker = source.match(/\nWrite-Host '\[1\/\d+\]/)?.[0];
  if (!stageMarker) throw new Error("installer stage marker not found");
  const functionSource = source.slice(0, source.indexOf(stageMarker));
  const virtualizationFirmwareEnabled = scenario === "missing-firmware" ? "$false" : "$true";
  const hypervisorPresent = scenario === "active-hypervisor" ? "$true" : "$false";
  const script = `${functionSource}
$mockCpu = [pscustomobject]@{
  VirtualizationFirmwareEnabled = ${virtualizationFirmwareEnabled}
  SecondLevelAddressTranslationExtensions = $false
  VMMonitorModeExtensions = $false
}
$mockComputerSystem = [pscustomobject]@{ HypervisorPresent = ${hypervisorPresent} }
function Get-CimInstance([string]$ClassName) {
  switch ($ClassName) {
    'Win32_OperatingSystem' { return [pscustomobject]@{ Caption = 'Microsoft Windows 11 Pro'; BuildNumber = '26100' } }
    'Win32_Processor' { return $mockCpu }
    'Win32_ComputerSystem' { return $mockComputerSystem }
    default { throw "Unexpected CIM class: $ClassName" }
  }
}
function Invoke-WebRequest { return [pscustomobject]@{} }
$ControlPlaneUrl = 'https://control.example'
$JoinCode = ('A' * 43)
try {
  Assert-HostPreflight
  Write-Output 'PREFLIGHT_OK'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
`;
  await Bun.write(scriptPath, script);
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: await proc.exited,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
async function invokeWindowsInstallerHarness(source: string, body: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "mars-installer-credentials-"));
  const scriptPath = join(tempDir, "harness.ps1");
  const stageMarker = source.match(/\nWrite-Host '\[1\/\d+\]/)?.[0];
  if (!stageMarker) throw new Error("installer stage marker not found");
  const functionSource = source.slice(0, source.indexOf(stageMarker));
  await Bun.write(scriptPath, `${functionSource}
${body}
`);
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: await proc.exited,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

windowsRuntimeTest("Windows installer replaces identity only for non-upgrade installs", async () => {
  const source = await Bun.file(powershell).text();
  const result = await invokeWindowsInstallerHarness(source, `
$dir = Join-Path $env:TEMP ('mars-credential-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $dir | Out-Null
$identityPath = Join-Path $dir 'worker-identity.json'
$identity = '{"workerId":"worker-123","machineUuid":"machine-456"}'
[IO.File]::WriteAllText($identityPath, $identity)
Reset-WorkerIdentity $identityPath $false
if (Test-Path -LiteralPath $identityPath) { throw 'fresh install preserved worker identity' }
[IO.File]::WriteAllText($identityPath, $identity)
Reset-WorkerIdentity $identityPath $true
if (-not (Test-Path -LiteralPath $identityPath)) { throw 'upgrade removed worker identity' }
Write-Output 'IDENTITY_SEMANTICS_OK'
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("IDENTITY_SEMANTICS_OK");
});

windowsRuntimeTest("Windows installer preserves resume and upgrade credential semantics", async () => {
  const source = await Bun.file(powershell).text();
  const result = await invokeWindowsInstallerHarness(source, `
$dir = Join-Path $env:TEMP ('mars-credential-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $dir | Out-Null
$joinPath = Join-Path $dir 'join-code'
$resumeCode = 'C' * 43
[IO.File]::WriteAllText($joinPath, $resumeCode)
function icacls.exe { $global:LASTEXITCODE = 0 }
Set-WorkerJoinCredential $joinPath $resumeCode
if ((Get-Content -LiteralPath $joinPath -Raw).Trim() -ne $resumeCode) { throw 'resume credential changed' }
$Upgrade = $true
if (-not $Upgrade) { Set-WorkerJoinCredential $joinPath ('D' * 43) }
if ((Get-Content -LiteralPath $joinPath -Raw).Trim() -ne $resumeCode) { throw 'upgrade replaced credential state' }
Write-Output 'CREDENTIAL_SEMANTICS_OK'
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("CREDENTIAL_SEMANTICS_OK");
});

windowsRuntimeTest("Windows installer waits for worker enrollment and rejects stopped or invalid workers", async () => {
  const source = await Bun.file(powershell).text();
  const result = await invokeWindowsInstallerHarness(source, `
$dir = Join-Path $env:TEMP ('mars-enrollment-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $dir | Out-Null
$identityPath = Join-Path $dir 'worker-identity.json'
function Get-Service([string]$Name, [string]$ErrorAction) {
  if ($global:mockServiceStatus -eq 'missing') { return $null }
  return [pscustomobject]@{ Status = $global:mockServiceStatus }
}
$global:mockServiceStatus = 'Running'
[IO.File]::WriteAllText($identityPath, '{"workerId":"worker-123"}')
$global:mockServiceStatus = 'missing'
try { Wait-WorkerEnrollment $identityPath 1; throw 'missing service was accepted' } catch { if ($_.Exception.Message -notmatch 'stopped before enrollment completed') { throw } }
$global:mockServiceStatus = 'Stopped'
try { Wait-WorkerEnrollment $identityPath 1; throw 'stopped service was accepted' } catch { if ($_.Exception.Message -notmatch 'stopped before enrollment completed') { throw } }
$global:mockServiceStatus = 'Running'
[IO.File]::WriteAllText($identityPath, '{"workerId":""}')
try { Wait-WorkerEnrollment $identityPath 0; throw 'missing workerId was accepted' } catch { if ($_.Exception.Message -notmatch 'did not enroll within 0 seconds') { throw } }
Write-Output 'ENROLLMENT_WAIT_OK'
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("ENROLLMENT_WAIT_OK");
});

for (const [script, runtimeTest] of [[linux, posixRuntimeTest], [mac, macosRuntimeTest]] as const) {
  runtimeTest(`${script} rejects missing or malformed code before host checks`, async () => {
    const missing = await invoke(script, []);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("usage:");
    for (const args of [["--unknown"], ["--code"], ["--code", ""], ["--code", valid, "--code", valid], ["--code", "short"], ["--control-plane-url", "https://control.example", "--code"], ["--control-plane-url", "https://control.example", "--code", "short"], ["--code", valid, "--control-plane-url"], ["--control-plane-url", "https://control.example", "--code", valid, "--unknown"]]) {
      const result = await invoke(script, args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
  });
  runtimeTest(`${script} accepts an explicit control-plane URL with the enrollment code`, async () => {
    const result = await invoke(script, ["--code", valid, "--control-plane-url", "https://control.example"], { PUBLIC_BASE_URL: "https://" });
    expect(result.exitCode).not.toBe(2);
    expect(result.stderr).not.toContain("usage:");
  });
  runtimeTest(`${script} rejects missing injected artifact config before host checks`, async () => {
    const result = await invoke(script, ["--code", valid, "--control-plane-url", "https://control.example"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("MARS_ARTIFACT_MODE is required");
    expect(result.stderr).not.toContain(script === linux ? "Linux is required" : "macOS is required");
  });
}

test("POSIX installers accept and apply an explicit control-plane URL", async () => {
  const [linuxSource, macSource] = await Promise.all([Bun.file(linux).text(), Bun.file(mac).text()]);
  for (const source of [linuxSource, macSource]) {
    expect(source).toContain("--control-plane-url");
    expect(source).toContain("CONTROL_PLANE_URL");
    expect(source).toContain('PUBLIC_BASE_URL="$CONTROL_PLANE_URL"');
  }
});

test("POSIX installers expose strict parser and stdin handoff", async () => {
  expect(await Bun.file(linux).text()).toContain("parse_args");
  expect(await Bun.file(mac).text()).toContain("--code");
  expect(await Bun.file(linux).text()).toContain("code=sys.stdin.readline()");
});

windowsRuntimeTest("Windows preflight trusts active hypervisor capability over false nested WMI flags", async () => {
  const source = await Bun.file(powershell).text();
  const activeHypervisor = await invokeWindowsPreflight(source, "active-hypervisor");
  expect(activeHypervisor.exitCode).toBe(0);
  expect(activeHypervisor.stdout).toContain("PREFLIGHT_OK");

  const missingFirmware = await invokeWindowsPreflight(source, "missing-firmware");
  expect(missingFirmware.exitCode).toBe(1);
  expect(missingFirmware.stderr).toContain("hardware virtualization is required.");

  const bareMetalWithoutSlat = await invokeWindowsPreflight(source, "bare-metal-no-slat");
  expect(bareMetalWithoutSlat.exitCode).toBe(1);
  expect(bareMetalWithoutSlat.stderr).toContain("hardware virtualization is required.");
});

test("PowerShell host preflight checks authoritative hypervisor state", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("Win32_ComputerSystem");
  expect(source).toContain("HypervisorPresent");
  expect(source).toContain("VirtualizationFirmwareEnabled");
});
test("macOS installer configures Tart sudo capability without switching to root", async () => {
  const source = await Bun.file(mac).text();
  expect(source).toContain("sudo -n \"$TART_BIN\" --version");
  expect(source).toContain("sudo -v");
  expect(source).toContain("/etc/sudoers.d/mars-tart-");
  expect(source).toContain("visudo -cf");
  expect(source).toContain('PLIST="$HOME/Library/LaunchAgents/com.mars.worker.plist"');
  expect(source).not.toContain("sudo zsh");
  expect(source).toContain('[[ "$EUID" -ne 0 ]]');
  expect(source).toContain("check 'Checking macOS host and Tart'");
  expect(source).toContain("pass()");
  expect(source).toContain("[✓]");
});
test("macOS installer provisions a persistent user-scoped worker service", async () => {
  const source = await Bun.file(mac).text();
  expect(source).toContain("/api/workers/orchestrator?audience=macos-arm64");
  expect(source).toContain("MARS_CONTROL_PLANE_URL");
  expect(source).toContain("mac-worker");
  expect(source).toContain("worker-identity.json");
  expect(source).toContain("launchctl bootstrap");
  expect(source).not.toContain("launchctl bootstrap system");
  expect(source).toContain('export MARS_TART_BASE_IMAGE=$(printf');
  expect(source).toContain('export MARS_TART_IMAGE_DIGEST=$(printf');
  expect(source).toContain('export MARS_TART_EXECUTABLE=$(printf');
  expect(source).not.toContain('if [[ -n "\\${TART_IMAGE_DIGEST:-}" ]]');
});
test("macOS installer requires injected artifacts before mutation and verifies the control-plane download", async () => {
  const source = await Bun.file(mac).text();
  for (const name of ["PUBLIC_BASE_URL", "MARS_ARTIFACT_MODE", "MARS_ORCHESTRATOR_SHA256", "TART_IMAGE", "TART_IMAGE_DIGEST"]) {
    expect(source).toContain(`${name} is required`);
  }
  expect(source).toContain('${PUBLIC_BASE_URL%/}/api/workers/orchestrator?audience=macos-arm64');
  expect(source).toContain('"$actual_hash" != "$MARS_ORCHESTRATOR_SHA256"');
  expect(source).toContain("orchestrator checksum mismatch");
  expect(source).toContain('[[ "$MARS_ARTIFACT_MODE" == production ]]');
  expect(source).toContain("TART_IMAGE must be digest-pinned in production");
  expect(source.lastIndexOf("validate_config")).toBeLessThan(source.indexOf("brew install"));
  expect(source.lastIndexOf("validate_config")).toBeLessThan(source.indexOf('mkdir -p "$APP_DIR"'));
});
test("macOS job image preparation is immutable, pinned, and emits split runtime identity", async () => {
  expect(await Bun.file(prepareMacImage).exists()).toBe(true);
  const source = await Bun.file(prepareMacImage).text();
  expect(source).toContain("2.336.0");
  expect(source).toContain("8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079");
  expect(source).toContain("target already exists");
  expect(source).toContain("image-manifest.json");
  expect(source).toContain("MARS_TART_BASE_IMAGE=");
  expect(source).toContain("MARS_TART_IMAGE_DIGEST=");
  expect(source).toContain('tart delete "$TARGET"');
});
macosRuntimeTest("macOS job image preparation accepts immutable OCI digest sources", async () => {
  const result = await invoke(prepareMacImage, ["--source", `ghcr.io/cirruslabs/macos-tahoe-base@sha256:${"a".repeat(64)}`, "--target", "invalid/target", "--job-agent", process.execPath]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("invalid target image");
  expect(result.stderr).not.toContain("invalid source image");
});
macosRuntimeTest("macOS job image preparation preserves the original failure during cleanup", async () => {
  const result = await invoke(prepareMacImage, ["--source", "source", "--target", "new-target", "--job-agent", process.execPath], { TART_BIN: "/usr/bin/true", CURL_BIN: "/usr/bin/false" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).not.toContain("read-only variable");
});


test("PowerShell installer supports VM and container runtime modes", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("[string]$WindowsContainerImage = 'mars/windows-job:local'");
  expect(source).toContain("ValidateSet('vm','container')");
  expect(source).toContain("Ensure-HyperV");
  expect(source).toContain("Ensure-ContainerFeatures");
  expect(source).toContain("Assert-WindowsContainerHost");
  expect(source).toContain("MARS_WINDOWS_RUNTIME");
  expect(source).toContain("MARS_WINDOWS_CONTAINER_IMAGE");
  expect(source).toContain("MARS_WINDOWS_TEMPLATE_PATH");
  expect(source).toContain("Reset-WorkerIdentity $identityPath $false");
  expect(source).toContain("preserving identity and resuming checkpoints");
  expect(source).toContain("replacing identity and runtime for a fresh enrollment");
  expect(source).toContain("Stop-Service MarsWorker");
  expect(source).toContain("New-Service -Name MarsWorker");
  expect(source).toContain("-StartupType Automatic");
  expect(source).toContain('sc.exe config MarsWorker depend= docker');
});
test("Windows installer fails when service registration fails", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain('$service = New-Service -Name MarsWorker');
  expect(source).toContain('Get-Service MarsWorker -ErrorAction Stop');
  expect(source).toContain('"reset= 86400"');
  expect(source).toContain('"actions= restart/5000/restart/30000/none/0"');
});
test("Windows installer rotates the previous worker log before startup", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("Move-Item -LiteralPath $workerLogPath -Destination $previousWorkerLogPath -Force");
});
test("Windows installer accepts a successful SCM recovery restart", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("$recoveryDeadline = (Get-Date).AddSeconds(15)");
  expect(source).toContain("$currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running");
  expect(source).toContain("recovered after initial startup failure");
  expect(source).toContain("Startup error: $startupError");
});
test("Windows installer stages runtime downloads before replacing a running service", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("$stagedExe = Join-Path $root 'mars-orchestrator.download'");
  expect(source).toContain("$stagedServiceHost = Join-Path $root 'mars-service-host.download'");
  expect(source).toContain("Download-WorkerArtifact $WindowsOrchestratorUrl $stagedExe");
  expect(source).toContain("Download-WorkerArtifact $WindowsServiceHostUrl $stagedServiceHost");
  expect(source).toContain("Move-Item -LiteralPath $stagedExe -Destination $exe -Force");
  expect(source.indexOf("Stop-Service MarsWorker")).toBeLessThan(source.indexOf("Move-Item -LiteralPath $stagedExe"));
});
test("Windows installer waits on a fresh service controller", async () => {
  const source = await Bun.file(powershell).text();
  expect(source.indexOf("$service = Get-Service MarsWorker -ErrorAction Stop")).toBeLessThan(source.indexOf("$service.WaitForStatus"));
});
test("Windows installer downloads and registers the native SCM host", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("$WindowsServiceHostUrl");
  expect(source).toContain("mars-service-host.exe");
  expect(source).toContain('-BinaryPathName "`"$serviceHost`"');
  expect(source).not.toContain("windows-worker --service");
});
test("Windows installer gives the service a fresh environment without rebooting", async () => {
  const source = await Bun.file(powershell).text();
  const serviceEnvironment = source.indexOf("$serviceEnvironment = @(");
  expect(serviceEnvironment).toBeGreaterThan(source.indexOf("$service = New-Service"));
  expect(serviceEnvironment).toBeLessThan(source.indexOf("Start-Service MarsWorker"));
  expect(source).toContain("HKLM:\\SYSTEM\\CurrentControlSet\\Services\\MarsWorker");
  expect(source).toContain("-Name Environment -PropertyType MultiString");
});
test("worker installers propagate optional cache service environment", async () => {
  const [windowsSource, macSource, composeSource, linuxSource] = await Promise.all([
    Bun.file(powershell).text(),
    Bun.file(mac).text(),
    Bun.file(linuxCompose).text(),
    Bun.file(linux).text(),
  ]);
  for (const name of [
    "MARS_ACTION_CACHE_ROOT",
    "MARS_CACHE_PROXY_PORT",
    "MARS_CACHE_DATA_PORT",
    "MARS_CACHE_PROXY_URL",
    "MARS_CACHE_ADVERTISE_URL",
    "MARS_CACHE_TOKEN_ISSUER",
    "MARS_CACHE_JWKS_URL",
  ]) {
    expect(windowsSource).toContain(name);
    expect(macSource).toContain(name);
    expect(composeSource).toContain(name);
  }
  expect(linuxSource).toContain("MARS_CACHE_TOKEN_ISSUER");
  expect(linuxSource).toContain("MARS_CACHE_JWKS_URL");
  expect(composeSource).toContain("${MARS_CACHE_PROXY_PORT:-8788}:${MARS_CACHE_PROXY_PORT:-8788}");
  expect(composeSource).toContain("${MARS_CACHE_DATA_PORT:-8789}:${MARS_CACHE_DATA_PORT:-8789}");
  expect(composeSource).toContain("/var/lib/mars/action-cache");
  expect(composeSource).toContain("action-cache:${MARS_ACTION_CACHE_ROOT:-/var/lib/mars/action-cache}");
});
test("Windows installer keeps the optional cache environment list valid PowerShell", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).not.toMatch(/'MARS_CACHE_ADVERTISE_URL',\r?\n\s*\)\) \{/);
});

test("Windows installer replaces duplicate worker cache firewall rules with one scoped rule", async () => {
  const source = await Bun.file(powershell).text();
  const name = "Mars Worker Cache";
  expect(source).toContain(`Get-NetFirewallRule -DisplayName '${name}'`);
  expect(source).toContain("Remove-NetFirewallRule");
  expect(source).toContain(`New-NetFirewallRule -DisplayName '${name}'`);
  expect(source).toContain("-Direction Inbound");
  expect(source).toContain("-Protocol TCP");
  expect(source).toContain("-Profile Domain,Private");
  expect(source).toContain("-RemoteAddress LocalSubnet");
  expect(source).toContain("-Program $exe");
  expect(source).toContain("$cacheProxyPort");
  expect(source).toContain("$cacheDataPort");
  expect(source).toContain("$cacheFirewallPorts");
  expect(source).toContain("between 1 and 65535");
  expect(source).toContain("-LocalPort $cacheFirewallPorts");
});
test("Windows installer restricts only the join credential, not the template root", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).not.toContain("$acl.SetAccessRuleProtection");
  expect(source).toContain("function Set-WorkerJoinCredential");
  expect(source).toContain("icacls.exe $Path /inheritance:r");
  expect(source).toContain("Failed to secure worker join credential");
});
test("Windows installer validates artifacts before container prerequisites without building an image", async () => {
  const source = await Bun.file(powershell).text();
  const main = source.slice(source.indexOf("Write-Host '[1/"), source.indexOf("Write-Host '[7/"));
  expect(source).toContain("Assert-WindowsContainerHost");
  expect(source).not.toContain("Build-LocalWindowsImage");
  expect(source).not.toContain("Ensure-WindowsContainerRuntime");
  expect(source).not.toContain("docker create");
  expect(source).not.toContain("docker wait");
  expect(source).not.toContain("docker logs");
  expect(main.indexOf("Verify-DownloadedFile")).toBeGreaterThanOrEqual(0);
  expect(main.indexOf("Verify-DownloadedFile")).toBeLessThan(main.indexOf("Install-DockerDesktop"));
  expect(main.indexOf("Set-WorkerJoinCredential")).toBeGreaterThan(main.lastIndexOf("Verify-DownloadedFile"));
  expect(source).toContain("MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST");
  expect(source).toContain("MARS_ALLOW_LOCAL_CONTAINER_IMAGE=true");
});
test("Windows installer uses seven ordered progress stages", async () => {
  const source = await Bun.file(powershell).text();
  for (const stage of [
    "[1/7] Checking administrator privileges",
    "[2/7] Checking Windows 11 Pro/Enterprise 24H2 x64 host",
    "[3/7] Checking control-plane connectivity and validating worker artifacts",
    "[4/7] Checking container runtime and installing prerequisites",
    "[5/7] Preparing worker replacement",
    "[6/7] Registering LocalSystem worker service",
    "[7/7] Starting worker service and waiting for enrollment",
  ]) expect(source).toContain(stage);
});
test("Windows installer removes obsolete image-build parameters", async () => {
  const source = await Bun.file(powershell).text();
  for (const name of [
    "WindowsContainerBaseImage", "WindowsContainerRunnerUrl", "WindowsContainerRunnerSha256",
    "WindowsContainerGitUrl", "WindowsContainerGitSha256", "WindowsContainerVcUrl",
    "WindowsContainerVcSha256", "WindowsContainerBuilderUrl", "WindowsContainerVerifierUrl",
    "WindowsContainerfileUrl", "WindowsContainerEntrypointUrl", "WindowsContainerJobAgentUrl",
  ]) expect(source).not.toContain(`$${name}`);
});
test("Windows installer preserves runtime environment for deferred image build", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("Assert-ImageDigest $WindowsContainerImage");
  expect(source).toContain("Install-DockerDesktop");
  expect(source).toContain("Switch-DockerWindowsEngine");
  expect(source).toContain("Assert-WindowsContainerHost");
  expect(source).toContain("MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST=$windowsImageManifestPath");
});
test("Windows installer exposes identity-preserving upgrade mode", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("[switch]$Upgrade");
  expect(source).toContain("[switch]$Resume");
  expect(source).toContain("Upgrade requires an existing worker identity.");
  expect(source).toContain("if ($Upgrade -and -not $existingService)");
  expect(source).toContain("if (-not $Upgrade) {");
});
test("Windows upgrade does not require a fresh enrollment join code", async () => {
  const source = await Bun.file(powershell).text();
  const validation = "if (-not $Upgrade -and ([string]::IsNullOrWhiteSpace($JoinCode) -or $JoinCode -notmatch '^[A-Za-z0-9_-]{43}$'))";
  expect(source).toContain(validation);
  expect(source.indexOf(validation)).toBeGreaterThan(source.indexOf("Ensure-ControlPlane"));
});
test("Windows fresh replacement clears identity and image manifest after prerequisites", async () => {
  const source = await Bun.file(powershell).text();
  const prerequisites = source.indexOf("Write-State 'prerequisites'");
  const reset = source.indexOf("Reset-WorkerIdentity $identityPath $false");
  const removeManifest = source.indexOf("Remove-Item -LiteralPath $windowsImageManifestPath");
  const serviceRemoval = source.indexOf("Stop-Service MarsWorker");
  expect(prerequisites).toBeGreaterThanOrEqual(0);
  expect(reset).toBeGreaterThan(prerequisites);
  expect(removeManifest).toBeGreaterThan(prerequisites);
  expect(reset).toBeLessThan(serviceRemoval);
  expect(removeManifest).toBeLessThan(serviceRemoval);
});
test("Windows installer does not require image-build metadata", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).not.toContain("WindowsContainerBaseImage");
  expect(source).not.toContain("WindowsContainerBuilderUrl");
});
test("Windows guest service runs as a startup-available system service account task", async () => {
  const source = await Bun.file(prepareWindowsTemplate).text();
  expect(source).toContain("New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount");
  expect(source).toContain("New-ScheduledTaskSettingsSet -StartWhenAvailable");
  expect(source).toContain("Register-ScheduledTask -TaskName 'MarsGuestService' -Action $action -Trigger $trigger -Principal $principal -Settings $settings");
});
test("orchestrator entrypoint uses the native host instead of a JavaScript service shim", async () => {
  const source = await Bun.file(join(root, "apps/orchestrator/src/index.ts")).text();
  expect(source).toContain('Bun.argv[2] === "windows-worker"');
  expect(source).not.toContain("--service");
  expect(source).not.toContain("runWindowsWorkerService");
});
test("Windows development preparation rebuilds the orchestrator artifact", async () => {
  const source = await Bun.file(join(root, "scripts/build-windows-worker.ts")).text();
  expect(source).toContain('"bun", "run", "--filter", "@mars/orchestrator", "build"');
  expect(source).toContain('"cargo", "build", "--release"');
});

test("Windows installer enforces HTTPS control-plane access", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("$ControlPlaneUrl -notmatch '^https://'");
  expect(source).toContain("Invoke-WebRequest");
  expect(source).toContain("-TimeoutSec 30");
});
windowsRuntimeTest("Windows local artifact mode rejects missing values without consulting GitHub metadata", async () => {
  const source = await Bun.file(powershell).text();
  const result = await invokeWindowsInstallerHarness(source, `
$WindowsArtifactMode = 'local'
$WindowsRuntime = 'vm'
$WindowsOrchestratorSha256 = ''
$WindowsServiceHostSha256 = ''
$WindowsTemplateUrl = ''
$WindowsTemplateDigest = ''
function Invoke-RestMethod { throw 'release metadata fallback invoked' }
try {
  Assert-ArtifactConfiguration
  throw 'local artifact validation unexpectedly passed'
} catch {
  if ($_.Exception.Message -notlike '*Windows worker artifacts*') { throw }
  Write-Output 'LOCAL_ARTIFACTS_REQUIRED'
}
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("LOCAL_ARTIFACTS_REQUIRED");
  expect(result.stdout).not.toContain("release metadata fallback invoked");
});
windowsRuntimeTest("Windows local artifact mode retains complete values without release metadata", async () => {
  const source = await Bun.file(powershell).text();
  const hash = "a".repeat(64);
  const result = await invokeWindowsInstallerHarness(source, `
$WindowsArtifactMode = 'local'
$WindowsRuntime = 'vm'
$WindowsOrchestratorSha256 = '${hash}'
$WindowsServiceHostSha256 = '${hash}'
$WindowsOrchestratorUrl = 'http://localhost:3000/api/workers/orchestrator?audience=windows-x64'
$WindowsServiceHostUrl = 'http://localhost:3000/api/workers/service-host?audience=windows-x64'
$WindowsTemplateUrl = 'http://localhost:3000/api/workers/templates/windows-x64/artifact'
$WindowsTemplateDigest = 'sha256:${hash}'
function Invoke-RestMethod { throw 'release metadata fallback invoked' }
Assert-ArtifactConfiguration
Write-Output 'LOCAL_ARTIFACTS_COMPLETE'
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("LOCAL_ARTIFACTS_COMPLETE");
  expect(result.stdout).not.toContain("release metadata fallback invoked");
});
windowsRuntimeTest("Windows local artifact mode requires explicit worker download URLs", async () => {
  const source = await Bun.file(powershell).text();
  const hash = "a".repeat(64);
  const result = await invokeWindowsInstallerHarness(source, `
$WindowsArtifactMode = 'local'
$WindowsRuntime = 'container'
$WindowsOrchestratorSha256 = '${hash}'
$WindowsServiceHostSha256 = '${hash}'
$WindowsOrchestratorUrl = ''
$WindowsServiceHostUrl = ''
function Invoke-RestMethod { throw 'release metadata fallback invoked' }
try {
  Assert-ArtifactConfiguration
  throw 'local artifact URL validation unexpectedly passed'
} catch {
  if ($_.Exception.Message -notlike '*Windows worker artifacts*') { throw }
  Write-Output 'LOCAL_URLS_REQUIRED'
}
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("LOCAL_URLS_REQUIRED");
  expect(result.stdout).not.toContain("release metadata fallback invoked");
});
windowsRuntimeTest("Windows local artifact mode permits loopback template downloads", async () => {
  const source = await Bun.file(powershell).text();
  const tempDir = await mkdtemp(join(tmpdir(), "mars-local-template-"));
  const templatePath = join(tempDir, "worker-template.vhdx");
  const hash = "a".repeat(64);
  try {
    const result = await invokeWindowsInstallerHarness(source, `
$WindowsArtifactMode = 'local'
$WindowsTemplateUrl = 'http://localhost:3000/api/workers/templates/windows-x64/artifact'
$WindowsTemplatePath = '${templatePath.replace(/\\/g, "\\\\")}'
$WindowsTemplateDigest = 'sha256:${hash}'
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile)
  [IO.File]::WriteAllText($OutFile, 'template')
  return [pscustomobject]@{}
}
function Get-FileHash {
  param([string]$Algorithm, [string]$LiteralPath)
  return [pscustomobject]@{ Hash = '${hash}' }
}
Download-Template
if (-not (Test-Path -LiteralPath '${templatePath.replace(/\\/g, "\\\\")}')) { throw 'local template was not downloaded' }
Write-Output 'LOCAL_TEMPLATE_URL_OK'
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("LOCAL_TEMPLATE_URL_OK");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
windowsRuntimeTest("Windows installer retries worker artifact downloads after transport closure", async () => {
  const source = await Bun.file(powershell).text();
  const destination = join(await mkdtemp(join(tmpdir(), "mars-artifact-download-")), "orchestrator.exe");
  const result = await invokeWindowsInstallerHarness(source, `
$global:downloadAttempts = 0
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
  $global:downloadAttempts++
  if ($global:downloadAttempts -eq 1) { throw [IO.IOException]::new('The connection was closed.') }
  [IO.File]::WriteAllText($OutFile, 'orchestrator')
  return [pscustomobject]@{ Headers = @{} }
}
$response = Download-WorkerArtifact 'https://control.example/api/workers/orchestrator' '${destination.replace(/\\/g, "\\\\")}'
if ($global:downloadAttempts -ne 2) { throw "expected two download attempts, got $global:downloadAttempts" }
if ((Get-Content -LiteralPath '${destination.replace(/\\/g, "\\\\")}' -Raw) -ne 'orchestrator') { throw 'artifact was not downloaded' }
if (-not $response) { throw 'download response was not returned' }
Write-Output 'ARTIFACT_RETRY_OK'
`);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("ARTIFACT_RETRY_OK");
});
test("Linux URL policy accepts a same-origin LAN HTTP artifact in local mode", async () => {
  const baseUrl = "http://192.168.50.7:3000";
  const origin = await invokeLinuxUrlValidation(baseUrl, "PUBLIC_BASE_URL", "origin", "local", baseUrl);
  const asset = await invokeLinuxUrlValidation(
    `${baseUrl}/api/workers/templates/linux-x64/artifact`,
    "MARS_GOLDEN_IMAGE",
    "asset",
    "local",
    baseUrl,
  );
  expect(origin.exitCode).toBe(0);
  expect(asset.exitCode).toBe(0);
});

test("Linux URL policy rejects artifact scheme, host, or port mismatches in local mode", async () => {
  for (const artifactUrl of [
    "https://192.168.50.7:3000/worker.qcow2",
    "http://192.168.50.8:3000/worker.qcow2",
    "http://192.168.50.7:3001/worker.qcow2",
  ]) {
    const result = await invokeLinuxUrlValidation(
      artifactUrl,
      "MARS_GOLDEN_IMAGE",
      "asset",
      "local",
      "http://192.168.50.7:3000",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("same origin as PUBLIC_BASE_URL");
  }
});

test("Linux URL policy rejects HTTP origins and assets in production mode", async () => {
  const origin = await invokeLinuxUrlValidation(
    "http://control.example.test",
    "PUBLIC_BASE_URL",
    "origin",
    "production",
    "http://control.example.test",
  );
  const asset = await invokeLinuxUrlValidation(
    "http://assets.example.test/worker.qcow2",
    "MARS_GOLDEN_IMAGE",
    "asset",
    "production",
    "https://control.example.test",
  );
  expect(origin.exitCode).toBe(1);
  expect(origin.stderr).toContain("HTTPS");
  expect(asset.exitCode).toBe(1);
  expect(asset.stderr).toContain("HTTPS");
});

test("Linux URL policy rejects credentials and fragments", async () => {
  const credentials = await invokeLinuxUrlValidation(
    "https://user:secret@control.example.test",
    "PUBLIC_BASE_URL",
    "origin",
    "local",
    "https://control.example.test",
  );
  const fragment = await invokeLinuxUrlValidation(
    "https://control.example.test/worker.qcow2#fragment",
    "MARS_GOLDEN_IMAGE",
    "asset",
    "local",
    "https://control.example.test",
  );
  expect(credentials.exitCode).toBe(1);
  expect(fragment.exitCode).toBe(1);
});

for (const [script, runtimeTest] of [[linux, posixRuntimeTest], [mac, macosRuntimeTest]] as const) {
  runtimeTest(`${script} local mode accepts a LAN HTTP control-plane origin`, async () => {
    const env = posixArtifactEnv(script, "local", "http://192.168.50.7:3000");
    const result = await invokePosixConfigValidation(script, env);
    expect(result.exitCode).toBe(0);
  });

  runtimeTest(`${script} production mode rejects an HTTP control-plane origin`, async () => {
    const env = posixArtifactEnv(script, "production", "http://192.168.50.7:3000");
    const result = await invokePosixConfigValidation(script, env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HTTPS");
  });

  runtimeTest(`${script} rejects credentials and fragments in the control-plane origin`, async () => {
    for (const baseUrl of ["http://user:secret@192.168.50.7:3000", "https://control.example.test/#fragment"]) {
      const env = posixArtifactEnv(script, "local", baseUrl);
      const result = await invokePosixConfigValidation(script, env);
      expect(result.exitCode).toBe(1);
    }
  });
}

macosRuntimeTest("macOS local mode rejects an HTTP Tart image from a different origin", async () => {
  const env = posixArtifactEnv(mac, "local", "http://192.168.50.7:3000");
  env.TART_IMAGE = "http://192.168.50.8:3000/images/mars-worker";
  const result = await invokePosixConfigValidation(mac, env);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("same origin as PUBLIC_BASE_URL");
});

macosRuntimeTest("macOS production mode rejects an HTTP Tart image URL", async () => {
  const env = posixArtifactEnv(mac, "production", "https://control.example.test");
  env.TART_IMAGE = `http://assets.example.test/mars-worker@sha256:${"a".repeat(64)}`;
  const result = await invokePosixConfigValidation(mac, env);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("HTTPS");
});

posixRuntimeTest("Linux local mode rejects artifact URLs from a different origin", async () => {
  const env = posixArtifactEnv(linux, "local", "http://192.168.50.7:3000", "http://192.168.50.8:3000");
  const result = await invokePosixConfigValidation(linux, env);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("same origin as PUBLIC_BASE_URL");
});

posixRuntimeTest("Linux production mode rejects HTTP artifact URLs", async () => {
  const env = posixArtifactEnv(linux, "production", "https://control.example.test", "http://control.example.test");
  const result = await invokePosixConfigValidation(linux, env);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("HTTPS");
});

posixRuntimeTest("Linux local mode rejects credentials and fragments in artifact URLs", async () => {
  for (const assetBaseUrl of [
    "http://user:secret@192.168.50.7:3000",
    "http://192.168.50.7:3000/#fragment",
  ]) {
    const env = posixArtifactEnv(linux, "local", "http://192.168.50.7:3000", assetBaseUrl);
    const result = await invokePosixConfigValidation(linux, env);
    expect(result.exitCode).toBe(1);
  }
});
posixRuntimeTest("Linux installer rejects noninteractive URL checks before host preflight", async () => {
  const rejected = await invoke(linux, [], { PUBLIC_BASE_URL: "https://" });
  const accepted = await invoke(linux, [], { PUBLIC_BASE_URL: "http://[::1]:8080" });
  const malformed = await invoke(linux, [], { PUBLIC_BASE_URL: "https://host:notaport" });
  expect(rejected.exitCode).toBe(2);
  expect(accepted.exitCode).toBe(2);
  expect(malformed.exitCode).toBe(2);
});
test("Windows VM installer downloads and verifies its immutable template before use", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("[string]$WindowsTemplateUrl = ''");
  expect(source).toContain("Invoke-WebRequest -Uri $WindowsTemplateUrl -OutFile $staged");
  expect(source).toContain("Get-FileHash -Algorithm SHA256 -LiteralPath $staged");
  expect(source.indexOf("Invoke-WebRequest -Uri $WindowsTemplateUrl")).toBeLessThan(source.indexOf("Assert-Template $WindowsTemplatePath"));
});
test("Linux installer requires injected control-plane artifacts and verifies them before startup", async () => {
  const source = await Bun.file(linux).text();
  for (const name of [
    "MARS_ARTIFACT_MODE",
    "MARS_BROKER_IMAGE",
    "MARS_GOLDEN_IMAGE",
    "MARS_GOLDEN_DIGEST",
    "MARS_COMPOSE_FILE",
    "MARS_COMPOSE_SHA256",
    "MARS_DOMAIN_TEMPLATE",
    "MARS_DOMAIN_TEMPLATE_SHA256",
  ]) {
    expect(source).toContain(`${name} is required`);
  }
  expect(source).toContain('download_asset "$MARS_GOLDEN_IMAGE" "$MARS_GOLDEN_DIGEST"');
  expect(source).toContain('download_asset "$MARS_COMPOSE_FILE" "$MARS_COMPOSE_SHA256"');
  expect(source).toContain('download_asset "$MARS_DOMAIN_TEMPLATE" "$MARS_DOMAIN_TEMPLATE_SHA256"');
  expect(source).toContain('[[ "$actual" == "$expected_hex" ]]');
  expect(source).toContain("sha256sum");
  expect(source).not.toContain("cosign verify-blob");
  expect(source).toContain("/var/lib/mars/install-state.json");
  expect(source).toContain("/var/log/mars/install.log");
  expect(source.indexOf("download_verified")).toBeLessThan(source.indexOf("docker compose"));
  expect(source.lastIndexOf("validate_config")).toBeLessThan(source.indexOf("check_kvm_access"));
  expect(source.lastIndexOf("validate_config")).toBeLessThan(source.indexOf("apt-get update"));
  expect(source).toContain('[[ "$MARS_ARTIFACT_MODE" == production ]]');
  expect(source).toContain("MARS_BROKER_IMAGE must be digest-pinned in production");
  expect(source).toContain('docker image inspect "$MARS_BROKER_IMAGE"');
});
test("fresh-host installers gate supported host versions before mutation and persist checkpoints", async () => {
  const [linuxSource, windowsSource, macSource] = await Promise.all([
    Bun.file(linux).text(),
    Bun.file(powershell).text(),
    Bun.file(mac).text(),
  ]);
  expect(linuxSource).toContain("Ubuntu 24.04");
  expect(linuxSource).toContain("sudo --preserve-env");
  expect(linuxSource).toContain("apt-get install");
  expect(linuxSource).toContain("systemctl enable --now libvirtd");
  expect(linuxSource).toContain("virsh net-autostart default");
  expect(linuxSource).toContain("install-state.json");
  expect(linuxSource).toContain("join-code");
  expect(windowsSource).toContain("Windows 11");
  expect(windowsSource).toContain("24H2");
  expect(windowsSource).toContain("Register-ScheduledTask");
  expect(windowsSource).toContain("MarsWorkerInstallResume");
  expect(windowsSource).toContain("Docker.DockerDesktop");
  expect(windowsSource).toContain("install-state.json");
  expect(macSource).toContain("sw_vers");
  expect(macSource).toContain("brew install");
  expect(macSource).toContain('"$TART_BIN" clone');
  expect(macSource).toContain("TART_IMAGE_DIGEST");
  expect(macSource).toContain("MARS_ORCHESTRATOR_SHA256");
  expect(macSource).toContain('"$actual_hash" != "$MARS_ORCHESTRATOR_SHA256"');
  expect(macSource).toContain("install-state.json");
});
test("installer preflight runs before host mutation and preserves protected credentials", async () => {
  const [linuxSource, windowsSource, macSource] = await Promise.all([
    Bun.file(linux).text(),
    Bun.file(powershell).text(),
    Bun.file(mac).text(),
  ]);
  expect(linuxSource.indexOf("preflight\nCONFIG_DIR")).toBeLessThan(linuxSource.indexOf("apt-get update"));
  expect(linuxSource.indexOf("preflight\nCONFIG_DIR")).toBeLessThan(linuxSource.indexOf("mkdir -p \"$CONFIG_DIR\""));
  expect(linuxSource).toContain("if [[ ! -f \"$JOIN_CODE_FILE\" ]]");
  expect(windowsSource.indexOf("Assert-HostPreflight\n$root")).toBeLessThan(windowsSource.indexOf("if (Ensure-ContainerFeatures)"));
  expect(windowsSource.indexOf("Assert-HostPreflight")).toBeLessThan(windowsSource.indexOf("Enable-WindowsOptionalFeature"));
  expect(windowsSource).toContain("Remove-ResumeTask");
  expect(windowsSource).not.toContain("Remove-Item -LiteralPath $identityPath -Force");
  expect(macSource.indexOf("sw_vers")).toBeLessThan(macSource.indexOf("brew install"));
  expect(macSource).toContain("if [[ ! -f \"$JOIN_CODE_FILE\" ]]");
  expect(macSource).not.toContain("rm -f \"$JOIN_CODE_FILE\"");
});
test("fresh-host blocker fixes remain fail-closed and resumable", async () => {
  const [linuxSource, composeSource, windowsSource, macSource] = await Promise.all([
    Bun.file(linux).text(),
    Bun.file(linuxCompose).text(),
    Bun.file(powershell).text(),
    Bun.file(mac).text(),
  ]);
  const sudoIndex = linuxSource.indexOf("exec sudo");
  const kvmIndex = linuxSource.indexOf("[[ -e /dev/kvm && -r /dev/kvm && -w /dev/kvm ]]");
  expect(kvmIndex).toBeGreaterThan(sudoIndex);
  expect(kvmIndex).toBeLessThan(linuxSource.indexOf("apt-get update"));
  expect(linuxSource).toContain('chown root:10001 "$CONFIG_DIR" "$JOIN_CODE_FILE"');
  expect(linuxSource).toContain('chmod 0640 "$JOIN_CODE_FILE"');
  expect(composeSource).toContain("MARS_JOIN_CODE_FILE: /var/lib/mars/config/join-code");
  expect(composeSource).toContain("${MARS_BROKER_CONFIG:?config directory required}:/var/lib/mars/config");
  expect(windowsSource).toContain("Install-DockerDesktop");
  expect(windowsSource).toContain("Refresh-ProcessPath");
  expect(windowsSource).toContain("[Environment]::GetEnvironmentVariable('Path', 'Machine')");
  expect(windowsSource).toContain("Switch-DockerWindowsEngine");
  const wingetIndex = windowsSource.indexOf("winget install");
  expect(windowsSource.indexOf("Refresh-ProcessPath", wingetIndex)).toBeGreaterThan(wingetIndex);
  expect(windowsSource).toContain("-WindowsServiceHostSha256");
  expect(windowsSource).toContain("Copy-Item -LiteralPath $PSCommandPath -Destination $persistentInstallerPath -Force");
  expect(windowsSource).toContain("Register-ResumeTask $persistentInstallerPath");
  expect(windowsSource.lastIndexOf("Remove-ResumeTask")).toBeGreaterThan(windowsSource.indexOf("Start-Service MarsWorker"));
  expect(macSource).toContain("${PUBLIC_BASE_URL%/}/api/healthz");
  expect(macSource).toContain("cleanup() {");
  expect(macSource).toContain('if [[ -f "\\$MARS_JOIN_CODE_FILE" ]]');
});
test("installers are self-contained and placeholder-free", async () => {
  const [linuxSource, windowsSource, macSource] = await Promise.all([
    Bun.file(linux).text(),
    Bun.file(powershell).text(),
    Bun.file(mac).text(),
  ]);
  expect(linuxSource).toContain("--code");
  expect(windowsSource).toContain("JoinCode");
  expect(macSource).toContain("--code");
  for (const source of [linuxSource, windowsSource, macSource]) {
    expect(source).not.toMatch(/__[A-Za-z0-9_]+__/);
    expect(source).not.toContain("worker-v0.1.0");
  }
  for (const source of [linuxSource, macSource]) {
    expect(source).toContain("--control-plane-url");
    expect(source).not.toContain("RELEASE_BASE_URL");
    expect(source).not.toContain("RELEASE_MANIFEST_URL");
    expect(source).not.toContain("worker-release-manifest.json");
    expect(source).not.toContain("https://github.com/Snazzie/Mars/releases");
    expect(source).not.toContain("manifest_value");
  }
  expect(windowsSource).not.toContain("https://github.com/Snazzie/Mars/releases/latest/download");
  expect(windowsSource).not.toContain("worker-release-manifest.json");
  expect(windowsSource).toContain("$WindowsOrchestratorUrl");
  expect(windowsSource).toContain("$WindowsServiceHostUrl");
  expect(windowsSource).toContain("$WindowsOrchestratorSha256");
  expect(windowsSource).toContain("$WindowsServiceHostSha256");
});
test("Windows installer requires explicit artifact URLs and has no release-manifest fallback", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("$WindowsArtifactMode");
  expect(source).toContain("$WindowsOrchestratorUrl");
  expect(source).toContain("$WindowsServiceHostUrl");
  expect(source).toContain("$WindowsOrchestratorSha256");
  expect(source).toContain("$WindowsServiceHostSha256");
  expect(source).not.toContain("Invoke-RestMethod");
  expect(source).not.toContain("worker-release-manifest.json");
  expect(source).not.toContain("https://github.com/Snazzie/Mars/releases/latest/download");
});
test("release installers apply passed control-plane URL and enrollment code", async () => {
  const [linuxSource, windowsSource, macSource] = await Promise.all([
    Bun.file(linux).text(),
    Bun.file(powershell).text(),
    Bun.file(mac).text(),
  ]);
  expect(linuxSource).toContain('PUBLIC_BASE_URL="$CONTROL_PLANE_URL"');
  expect(linuxSource).toContain("printf '%s\\n' \"$JOIN_CODE\"");
  expect(windowsSource).toContain("$ControlPlaneUrl");
  expect(windowsSource).toContain("$JoinCode");
  expect(windowsSource).toContain("[Alias('Code')]");
  expect(macSource).toContain('PUBLIC_BASE_URL="$CONTROL_PLANE_URL"');
  expect(macSource).toContain("printf '%s\\n' \"$JOIN_CODE\"");
});
test("Windows local installer values define control-plane artifact endpoints", () => {
  const hash = "b".repeat(64);
  const values = windowsInstallerValues(undefined, "https://control.test", {
    orchestrator: { sha256: hash },
    serviceHost: { sha256: hash },
    template: { sha256: hash },
    container: {
      baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
      runner: { sha256: hash },
      git: { sha256: hash },
      vcRuntime: { sha256: hash },
    },
  });

  expect(values).toMatchObject({
    WindowsArtifactMode: "local",
    WindowsOrchestratorUrl: "https://control.test/api/workers/orchestrator?audience=windows-x64",
    WindowsServiceHostUrl: "https://control.test/api/workers/service-host?audience=windows-x64",
    WindowsTemplateUrl: "https://control.test/api/workers/templates/windows-x64/artifact",
    WindowsContainerRunnerUrl: "https://control.test/api/workers/windows-container-runner",
    WindowsContainerGitUrl: "https://control.test/api/workers/windows-container-git",
    WindowsContainerVcRuntimeUrl: "https://control.test/api/workers/windows-container-vc-runtime",
    WindowsOrchestratorSha256: hash,
    WindowsServiceHostSha256: hash,
    WindowsTemplateDigest: `sha256:${hash}`,
    WindowsContainerRunnerSha256: hash,
    WindowsContainerGitSha256: hash,
    WindowsContainerVcRuntimeSha256: hash,
  });
});
test("Windows local installer values never bypass control-plane artifact endpoints", () => {
  const hash = "c".repeat(64);
  const values = windowsInstallerValues(undefined, "https://control.test", {
    orchestrator: { url: "https://external.test/orchestrator.exe", sha256: hash },
    serviceHost: { url: "https://external.test/service-host.exe", sha256: hash },
    template: { url: "https://external.test/template.vhdx", sha256: hash },
    container: {
      baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
      runner: { url: "https://external.test/runner.zip", sha256: hash },
      git: { url: "https://external.test/git.zip", sha256: hash },
      vcRuntime: { url: "https://external.test/vc.exe", sha256: hash },
    },
  });

  expect(values.WindowsOrchestratorUrl).toBe("https://control.test/api/workers/orchestrator?audience=windows-x64");
  expect(values.WindowsServiceHostUrl).toBe("https://control.test/api/workers/service-host?audience=windows-x64");
  expect(values.WindowsTemplateUrl).toBe("https://control.test/api/workers/templates/windows-x64/artifact");
  expect(values.WindowsContainerRunnerUrl).toBe("https://control.test/api/workers/windows-container-runner");
  expect(values.WindowsContainerGitUrl).toBe("https://control.test/api/workers/windows-container-git");
  expect(values.WindowsContainerVcRuntimeUrl).toBe("https://control.test/api/workers/windows-container-vc-runtime");
});
test("Windows release installer values include explicit artifact URLs", () => {
  const hash = "d".repeat(64);
  const values = windowsInstallerValues({
    orchestratorSha256: hash,
    serviceHostSha256: hash,
    vmTemplateUrl: "https://release.test/worker-template.vhdx",
    vmTemplateSha256: hash,
    container: {
      baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
      runner: { url: "https://release.test/runner.zip", sha256: hash },
      git: { url: "https://release.test/git.zip", sha256: hash },
      vcRuntime: { url: "https://release.test/vc.exe", sha256: hash },
    },
  }, "https://control.test");

  expect(values).toMatchObject({
    WindowsOrchestratorUrl: "https://control.test/api/workers/orchestrator?audience=windows-x64",
    WindowsServiceHostUrl: "https://control.test/api/workers/service-host?audience=windows-x64",
    WindowsTemplateUrl: "https://release.test/worker-template.vhdx",
    WindowsContainerRunnerUrl: "https://release.test/runner.zip",
    WindowsContainerGitUrl: "https://release.test/git.zip",
    WindowsContainerVcRuntimeUrl: "https://release.test/vc.exe",
    WindowsOrchestratorSha256: hash,
    WindowsServiceHostSha256: hash,
    WindowsTemplateDigest: `sha256:${hash}`,
    WindowsContainerRunnerSha256: hash,
    WindowsContainerGitSha256: hash,
    WindowsContainerVcRuntimeSha256: hash,
  });
});
