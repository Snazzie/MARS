import { expect, test } from "bun:test";
import { buildWindowsUpgradeCommand } from "./WorkerActions.tsx";

test("builds a Windows upgrade command for the existing worker", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example/", "container");
  expect(command).toContain("https://control.example/api/workers/installer?audience=windows-x64&runtime=container");
  expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass");
});

test("defaults Windows upgrades to container mode", () => {
  expect(buildWindowsUpgradeCommand("worker", "https://control.example")).toContain("runtime=container");
});
