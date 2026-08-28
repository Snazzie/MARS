import { expect, test } from "bun:test";
import { buildWindowsUpgradeCommand } from "./WorkerActions.tsx";

test("builds a Windows upgrade command from the immutable v1 release asset", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example/", "https://adapter.example");
  expect(command).toContain("https://github.com/Snazzie/Mars/releases/latest/download/install-worker-windows-x64.ps1");
  expect(command).not.toContain("worker-v0.1.0");
  expect(command).toContain("-ControlPlaneUrl 'https://adapter.example'");
  expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass");
  expect(command).toContain("-Upgrade -WindowsRuntime 'container'");
  expect(command).toContain("Remove-Item -LiteralPath $script");
});

test("allows localhost control planes to use HTTP while downloading the release over HTTPS", () => {
  const command = buildWindowsUpgradeCommand("worker", "http://localhost:5173");
  expect(command).toContain("--proto '=https'");
  expect(command).toContain("-AllowInsecureHttp");
  expect(command).not.toContain("--proto '=http'");
});

test("cannot select a Windows VM runtime for upgrades", async () => {
  const source = await Bun.file(new URL("./WorkerActions.tsx", import.meta.url)).text();
  expect(source).not.toContain("Windows VM");
  expect(buildWindowsUpgradeCommand("worker", "https://control.example")).toContain("-WindowsRuntime 'container'");
});
