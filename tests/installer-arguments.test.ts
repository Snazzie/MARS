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


test("PowerShell installer enforces Windows-container Hyper-V isolation", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("Write-ChecklistStep");
  expect(source).toContain("Ensure-WindowsFeatures");
  expect(source).toContain("Get-WindowsOptionalFeature");
  expect(source).toContain("docker info");
  expect(source).toContain("OSType");
  expect(source).toContain("--isolation=hyperv");
  expect(source).toContain("Assert-ImmutableImage");
  expect(source).toContain("WHITESMITH_WINDOWS_CONTAINER_IMAGE");
  expect(source).not.toContain("WHITESMITH_WINDOWS_VHDX");
  expect(source).toContain("sc.exe create WhitesmithWorker");
  expect(source).toContain("obj= LocalSystem");
});
test("Windows container image preparation is pinned and emits a manifest", async () => {
  const script = await Bun.file(join(root, "deploy/workers/prepare-windows-container-image.ps1")).text();
  expect(script).toContain("Assert-Image");
  expect(script).toContain("docker build");
  expect(script).toContain("docker image inspect");
  expect(script).toContain("whitesmith-job-agent.exe");
  expect(script).toContain("ConvertTo-Json");
});
test("orchestrator entrypoint dispatches platform worker commands", async () => {
  const source = await Bun.file(join(root, "apps/orchestrator/src/index.ts")).text();
  expect(source).toContain('Bun.argv[2] === "mac-worker"');
  expect(source).toContain('Bun.argv[2] === "windows-worker"');
  expect(source).toContain("runWindowsWorkerService");
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
