import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const linux = join(root, "deploy/workers/install-worker.sh");
const mac = join(root, "deploy/workers/install-worker-macos.sh");
const powershell = join(root, "deploy/workers/install-worker.ps1");
const valid = "A".repeat(43);

async function invoke(script: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(script.endsWith(".sh") ? [script, ...args] : ["zsh", script, ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

test.each([linux, mac])("%s rejects missing, unknown, empty, duplicate, and malformed code before host checks", async (script) => {
  for (const args of [[], ["--unknown"], ["--code"], ["--code", ""], ["--code", valid, "--code", valid], ["--code", "short"]]) {
    const result = await invoke(script, args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--code");
  }
});

test("POSIX installers expose strict parser and stdin handoff", async () => {
  expect(await Bun.file(linux).text()).toContain("parse_args");
  expect(await Bun.file(mac).text()).toContain("--code");
  expect(await Bun.file(linux).text()).toContain("code=sys.stdin.readline()");
  expect(await Bun.file(mac).text()).toContain("--code-stdin");
});

test("PowerShell requires and validates Code without interactive prompt", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("[Parameter(Mandatory=$true)]");
  expect(source).toContain("[string]$Code");
  expect(source).toContain("43}$");
  expect(source).toContain("finally");
  expect(source).not.toContain("Read-Host");
  expect(source).toContain("--code-stdin");
});
test("PowerShell checks join exit status and cleans up a failed VM", async () => {
  const source = await Bun.file(powershell).text();
  expect(source).toContain("ProcessStartInfo");
  expect(source).toContain("$process.ExitCode -ne 0");
  expect(source).toContain("Stop-VM");
  expect(source).toContain("Remove-VM");
  expect(source).toContain("catch");
  expect(source).toContain("Write-Host");
});
test("orchestrator entrypoint dispatches join stdin", async () => {
  const source = await Bun.file(join(root, "apps/orchestrator/src/index.ts")).text();
  expect(source).toContain('Bun.argv[2] === "join"');
  expect(source).toContain("runWorkerJoin");
});
test("join enforces HTTPS policy and bounded waits", async () => {
  const source = await Bun.file(join(root, "apps/orchestrator/src/mac-agent.ts")).text();
  expect(source).toContain('url.protocol !== "https:"');
  expect(source).toContain("AbortSignal.timeout(30_000)");
  expect(await Bun.file(powershell).text()).toContain("WaitForExit(30000)");
});
test("Linux installer validates public URL scheme", async () => {
  const source = await Bun.file(linux).text();
  expect(source).toContain("validate_control_plane_url");
  expect(source).toContain("https://");
  expect(source).toContain('"localhost"');
  expect(source).toContain("PUBLIC_BASE_URL must use HTTPS");
});
test("Linux URL parser rejects empty-host HTTPS and accepts loopback IPv6 HTTP", async () => {
  const rejected = await invoke(linux, ["--code", valid], { PUBLIC_BASE_URL: "https://" });
  expect(rejected.exitCode).toBe(1);
  const accepted = await invoke(linux, ["--code", valid], { PUBLIC_BASE_URL: "http://[::1]:8080" });
  expect(accepted.exitCode).not.toBe(2);
});
