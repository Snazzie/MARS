import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const linux = join(root, "deploy/workers/install-worker.sh");
const mac = join(root, "deploy/workers/install-worker-macos.sh");
const prepareMacImage = join(root, "deploy/workers/prepare-macos-job-image.sh");
const powershell = join(root, "deploy/workers/install-worker.ps1");
const valid = "A".repeat(43);

async function invoke(script: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(script.endsWith(".sh") ? [script, ...args] : ["zsh", script, ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

test.each([linux, mac])("%s rejects missing or malformed code before host checks", async (script) => {
  const missing = await invoke(script, []);
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("usage:");
  for (const args of [["--unknown"], ["--code"], ["--code", ""], ["--code", valid, "--code", valid], ["--code", "short"]]) {
    const result = await invoke(script, args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage:");
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
  expect(source).toContain("/etc/sudoers.d/whitesmith-tart-");
  expect(source).toContain("visudo -cf");
  expect(source).toContain('PLIST="$HOME/Library/LaunchAgents/com.whitesmith.worker.plist"');
  expect(source).not.toContain("sudo zsh");
  expect(source).toContain('[[ "$EUID" -ne 0 ]]');
  expect(source).toContain("check 'Checking macOS host and Tart'");
  expect(source).toContain("pass()");
  expect(source).toContain("[✓]");
});
test("macOS installer provisions a persistent user-scoped worker service", async () => {
  const source = await Bun.file(mac).text();
  expect(source).toContain("/api/workers/orchestrator?audience=macos-arm64");
  expect(source).toContain("WHITESMITH_CONTROL_PLANE_URL");
  expect(source).toContain("mac-worker");
  expect(source).toContain("worker-identity.json");
  expect(source).toContain("launchctl bootstrap");
  expect(source).not.toContain("launchctl bootstrap system");
  expect(source).toContain('export WHITESMITH_TART_BASE_IMAGE=$(printf');
  expect(source).toContain('export WHITESMITH_TART_IMAGE_DIGEST=$(printf');
  expect(source).toContain('export WHITESMITH_TART_EXECUTABLE=$(printf');
  expect(source).not.toContain('if [[ -n "\\${TART_IMAGE_DIGEST:-}" ]]');
});
test("macOS job image preparation is immutable, pinned, and emits split runtime identity", async () => {
  expect(await Bun.file(prepareMacImage).exists()).toBe(true);
  const source = await Bun.file(prepareMacImage).text();
  expect(source).toContain("2.336.0");
  expect(source).toContain("8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079");
  expect(source).toContain("target already exists");
  expect(source).toContain("image-manifest.json");
  expect(source).toContain("WHITESMITH_TART_BASE_IMAGE=");
  expect(source).toContain("WHITESMITH_TART_IMAGE_DIGEST=");
  expect(source).toContain('tart delete "$TARGET"');
});
test("macOS job image preparation accepts immutable OCI digest sources", async () => {
  const result = await invoke(prepareMacImage, ["--source", `ghcr.io/cirruslabs/macos-tahoe-base@sha256:${"a".repeat(64)}`, "--target", "invalid/target", "--job-agent", process.execPath]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("invalid target image");
  expect(result.stderr).not.toContain("invalid source image");
});
test("macOS job image preparation preserves the original failure during cleanup", async () => {
  const result = await invoke(prepareMacImage, ["--source", "source", "--target", "new-target", "--job-agent", process.execPath], { TART_BIN: "/usr/bin/true", CURL_BIN: "/usr/bin/false" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).not.toContain("read-only variable");
});


test("PowerShell installer enforces native Hyper-V templates", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("Ensure-HyperV");
  expect(source).toContain("Get-WindowsOptionalFeature");
  expect(source).toContain("Get-VMHost");
  expect(source).toContain("Assert-Digest");
  expect(source).toContain("WHITESMITH_WINDOWS_TEMPLATE_PATH");
  expect(source).not.toContain("WHITESMITH_WINDOWS_CONTAINER_IMAGE");
  expect(source).toContain("New-Service -Name WhitesmithWorker");
  expect(source).toContain("-StartupType Automatic");
});
test("Windows installer skips optional Linux validation when Linux templates are unset", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("if ($LinuxTemplatePath -and $LinuxTemplateDigest)");
});
test("Windows installer fails when service registration fails", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain('$service = New-Service -Name WhitesmithWorker');
  expect(source).toContain('Get-Service WhitesmithWorker -ErrorAction Stop');
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
  expect(source).toContain("$stagedExe = Join-Path $root 'whitesmith-orchestrator.download'");
  expect(source).toContain("$stagedServiceHost = Join-Path $root 'whitesmith-service-host.download'");
  expect(source).toContain('OutFile $stagedExe');
  expect(source).toContain('OutFile $stagedServiceHost');
  expect(source).toContain("Move-Item -LiteralPath $stagedExe -Destination $exe -Force");
  expect(source.indexOf("Stop-Service WhitesmithWorker")).toBeLessThan(source.indexOf("Move-Item -LiteralPath $stagedExe"));
});
test("Windows installer downloads and registers the native SCM host", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("/api/workers/service-host?audience=windows-x64");
  expect(source).toContain("whitesmith-service-host.exe");
  expect(source).toContain('-BinaryPathName "`"$serviceHost`"');
  expect(source).not.toContain("windows-worker --service");
});
test("Windows installer restricts only the join credential, not the template root", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).not.toContain("$acl.SetAccessRuleProtection");
  expect(source).toContain("icacls.exe $joinCodePath /inheritance:r");
  expect(source).toContain("Failed to secure worker join credential");
});
test("Hyper-V worker preparation is not Docker-based", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).not.toContain("docker");
  expect(source).not.toContain("Windows Containers");
});
test("orchestrator entrypoint uses the native host instead of a JavaScript service shim", async () => {
  const source = await Bun.file(join(root, "apps/orchestrator/src/index.ts")).text();
  expect(source).toContain('Bun.argv[2] === "windows-worker"');
  expect(source).not.toContain("--service");
  expect(source).not.toContain("runWindowsWorkerService");
});
test("Windows development preparation rebuilds the orchestrator artifact", async () => {
  const source = await Bun.file(join(root, "scripts/build-windows-worker.ts")).text();
  expect(source).toContain('"bun", "run", "--filter", "@whitesmith/orchestrator", "build"');
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
test("Linux installer rejects noninteractive URL checks before host preflight", async () => {
  const rejected = await invoke(linux, [], { PUBLIC_BASE_URL: "https://" });
  const accepted = await invoke(linux, [], { PUBLIC_BASE_URL: "http://[::1]:8080" });
  const malformed = await invoke(linux, [], { PUBLIC_BASE_URL: "https://host:notaport" });
  expect(rejected.exitCode).toBe(2);
  expect(accepted.exitCode).toBe(2);
  expect(malformed.exitCode).toBe(2);
});
