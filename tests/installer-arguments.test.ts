import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const linux = join(root, "deploy/workers/install-worker.sh");
const mac = join(root, "deploy/workers/install-worker-macos.sh");
const powershell = join(root, "deploy/workers/install-worker.ps1");
const valid = "A".repeat(43);

async function invoke(script: string, args: string[]) {
  const proc = Bun.spawn(script.endsWith(".sh") ? [script, ...args] : ["zsh", script, ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
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
