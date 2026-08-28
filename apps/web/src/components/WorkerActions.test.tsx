import { expect, test } from "bun:test";
import { buildWindowsUpgradeCommand } from "./WorkerActions.tsx";
import { isLocalDevelopment } from "../environment.ts";

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

test("uses the local installer endpoint for development upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "http://localhost:3000", "http://localhost:3000", true);
  expect(command).toContain("http://localhost:3000/api/workers/installer?");
  expect(command).toContain("audience=windows-x64");
  expect(command).toContain("runtime=container");
  expect(command).toContain("connectOrigin=http%3A%2F%2Flocalhost%3A3000");
  expect(command).not.toContain("github.com/Snazzie/Mars/releases");
});
test("uses the control-plane origin instead of the Vite browser origin for local upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "http://localhost:5173", "http://localhost:3000", true);
  expect(command).toContain("http://localhost:3000/api/workers/installer?");
  expect(command).toContain("connectOrigin=http%3A%2F%2Flocalhost%3A3000");
  expect(command).toContain("-ControlPlaneUrl 'http://localhost:3000'");
  expect(command).not.toContain("localhost:5173");
});

test("uses a Bun-safe production default when no explicit mode override is provided", () => {
  expect(isLocalDevelopment()).toBe(false);
  expect(buildWindowsUpgradeCommand("worker/id", "https://control.example")).toContain("github.com/Snazzie/Mars/releases");
});
test("renders upgrade preparation errors outside the closed action confirmation dialog", async () => {
  const source = await Bun.file(new URL("./WorkerActions.tsx", import.meta.url)).text();
  expect(source).toContain("upgradeError");
  expect(source).toContain('{upgradeError && <p className="inline-error" role="alert">{upgradeError}</p>}');
});

test("uses the GitHub release installer for production upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example", "https://control.example", false);
  expect(command).toContain("https://github.com/Snazzie/Mars/releases/latest/download/install-worker-windows-x64.ps1");
});