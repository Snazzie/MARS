import { expect, test } from "bun:test";
import { join } from "node:path";

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

async function invoke(script: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(script.endsWith(".sh") ? [script, ...args] : ["zsh", script, ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

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
  expect(source).toContain("Ensure-WindowsContainerRuntime");
  expect(source).toContain("MARS_WINDOWS_RUNTIME");
  expect(source).toContain("MARS_WINDOWS_CONTAINER_IMAGE");
  expect(source).toContain("MARS_WINDOWS_TEMPLATE_PATH");
  expect(source).not.toContain("Remove-Item -LiteralPath $identityPath -Force");
  expect(source).toContain("preserving identity and resuming checkpoints");
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
  expect(source).toContain('OutFile $stagedExe');
  expect(source).toContain('OutFile $stagedServiceHost');
  expect(source).toContain("Move-Item -LiteralPath $stagedExe -Destination $exe -Force");
  expect(source.indexOf("Stop-Service MarsWorker")).toBeLessThan(source.indexOf("Move-Item -LiteralPath $stagedExe"));
});
test("Windows installer waits on a fresh service controller", async () => {
  const source = await Bun.file(powershell).text();
  expect(source.indexOf("$service = Get-Service MarsWorker -ErrorAction Stop")).toBeLessThan(source.indexOf("$service.WaitForStatus"));
});
test("Windows installer downloads and registers the native SCM host", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("/api/workers/service-host?audience=windows-x64");
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
  const [windowsSource, macSource, composeSource] = await Promise.all([
    Bun.file(powershell).text(),
    Bun.file(mac).text(),
    Bun.file(linuxCompose).text(),
  ]);
  for (const name of [
    "MARS_ACTION_CACHE_ROOT",
    "MARS_CACHE_PROXY_PORT",
    "MARS_CACHE_DATA_PORT",
    "MARS_CACHE_PROXY_URL",
    "MARS_CACHE_ADVERTISE_URL",
  ]) {
    expect(windowsSource).toContain(name);
    expect(macSource).toContain(name);
    expect(composeSource).toContain(name);
  }
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
  expect(source).toContain("icacls.exe $joinCodePath /inheritance:r");
  expect(source).toContain("Failed to secure worker join credential");
});
test("Windows installer supports Docker mode with a fail-closed runtime probe", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("Ensure-WindowsContainerRuntime");
  expect(source).toContain("--isolation=hyperv");
  expect(source).toContain("verify-runtime.ps1");
  expect(source).toContain("-RequireNetwork");
  expect(source).toContain("docker wait");
  expect(source).toContain("docker logs");
  expect(source).toContain("2000");
  expect(source).toContain("MARS_WINDOWS_RUNTIME");
  expect(source).toContain("MARS_WINDOWS_TEMPLATE_PATH");
});
test("Windows installer exposes identity-preserving upgrade mode", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("[switch]$Upgrade");
  expect(source).toContain("Upgrade requires an existing worker identity.");
  expect(source).toContain("if ($Upgrade -and -not $existingService)");
  expect(source).toContain("if (-not $Upgrade) {");
});
test("Windows container upgrades reuse the existing verified image", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("if ($Upgrade) {");
  expect(source).toContain("Assert-LocalImageManifest $windowsImageManifestPath $WindowsContainerImage");
  expect(source).toContain("Ensure-WindowsContainerRuntime $WindowsContainerImage $WindowsContainerPrefix");
  expect(source).toContain("elseif ($AllowLocalContainerImage -and (Test-Path -LiteralPath $windowsImageManifestPath))");
  expect(source).toContain("Existing local Windows image state is stale; rebuilding");
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
test("Linux installer accepts configured HTTP or HTTPS control-plane URLs", async () => {
  const source = await Bun.file(linux).text();
  expect(source).toContain("validate_control_plane_url");
  expect(source).toContain('parsed.scheme not in {"https", "http"}');
  expect(source).toContain("PUBLIC_BASE_URL must use HTTP or HTTPS");
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
test("Linux installer normalizes manifest golden digest for orchestrator", async () => {
  const source = await Bun.file(linux).text();
  expect(source).toContain('MARS_GOLDEN_DIGEST="${MARS_GOLDEN_DIGEST:-sha256:$(manifest_value');
  expect(source).toContain('validate_sha256 "$MARS_GOLDEN_DIGEST" "golden image"');
  expect(source).toContain('MARS_GOLDEN_DIGEST:-');
});
test("Linux installer materializes and verifies remote worker assets before startup", async () => {
  const source = await Bun.file(linux).text();
  expect(source).toContain("RELEASE_MANIFEST_URL");
  expect(source).toContain("MARS_GOLDEN_IMAGE");
  expect(source).toContain("MARS_COMPOSE_SHA256");
  expect(source).toContain("MARS_DOMAIN_TEMPLATE_SHA256");
  expect(source).toContain("curl --silent --show-error --fail");
  expect(source).toContain("sha256sum");
  expect(source).not.toContain("cosign verify-blob");
  expect(source).toContain("/var/lib/mars/install-state.json");
  expect(source).toContain("/var/log/mars/install.log");
  expect(source.indexOf("download_verified")).toBeLessThan(source.indexOf("docker compose"));
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
  expect(macSource).toContain("tart clone");
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
test("GitHub release installers are self-contained and placeholder-free", async () => {
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
    expect(source).toContain("https://github.com/Snazzie/Mars/releases/latest/download");
    expect(source).not.toContain("worker-v0.1.0");
  }
  for (const source of [linuxSource, macSource]) {
    expect(source).toContain("--control-plane-url");
  }
  expect(linuxSource).toContain("worker-release-manifest.json");
  expect(windowsSource).toContain("worker-release-manifest.json");
  expect(macSource).toContain("worker-release-manifest.json");
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
