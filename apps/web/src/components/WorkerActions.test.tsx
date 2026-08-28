import { expect, test } from "bun:test";
import { buildWindowsUpgradeCommand } from "./WorkerActions.tsx";

test("builds a Windows upgrade command for the existing worker", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example/", "container", "https://adapter.example");
  expect(command).toContain("https://adapter.example/api/workers/installer?audience=windows-x64&runtime=container&connectOrigin=https%3A%2F%2Fadapter.example");
  expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass");
  expect(command).toContain("-Upgrade -WindowsRuntime 'container'");
});

test("allows localhost control planes to use HTTP", () => {
  const command = buildWindowsUpgradeCommand("worker", "http://localhost:5173", "container");
  expect(command).toContain("--proto '=http'");
  expect(command).toContain("-AllowInsecureHttp");
  expect(command).not.toContain("--proto '=https'");
});
test("defaults Windows upgrades to container mode", () => {
  expect(buildWindowsUpgradeCommand("worker", "https://control.example")).toContain("runtime=container");
});
