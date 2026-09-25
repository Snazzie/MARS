import { expect, test } from "bun:test";
import { buildWindowsUpgradeCommand } from "./WorkerActions.tsx";

test("builds a Windows upgrade command from the selected control-plane installer", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example/", "https://adapter.example");
  expect(command).toContain("https://adapter.example/api/workers/installer?audience=windows-x64&upgrade=true&connectOrigin=https%3A%2F%2Fadapter.example");
  expect(command).not.toContain("releases/latest/download");
  expect(command).toContain("-ControlPlaneUrl 'https://adapter.example'");
  expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass");
  expect(command).toContain("-Upgrade");
  expect(command).not.toContain("-WindowsRuntime");
  expect(command).toContain("Remove-Item -LiteralPath $script");
});

test("allows localhost control planes to use HTTP for the installer and worker connection", () => {
  const command = buildWindowsUpgradeCommand("worker", "http://localhost:5173");
  expect(command).toContain("--proto '=http'");
  expect(command).toContain("-AllowInsecureHttp");
  expect(command).not.toContain("--tlsv1.3");
});

test("does not infer or retain a Windows runtime selection during upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker", "https://control.example", "https://control.example");
  expect(command).not.toContain("runtime=vm");
  expect(command).not.toContain("-WindowsRuntime");
});

test("uses the control-plane installer endpoint for development upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "http://localhost:3000", "http://localhost:3000");
  expect(command).toContain("http://localhost:3000/api/workers/installer?");
  expect(command).toContain("audience=windows-x64");
  expect(command).not.toContain("runtime=");
  expect(command).toContain("connectOrigin=http%3A%2F%2Flocalhost%3A3000");
  expect(command).not.toContain("releases/latest/download");
});
test("uses the control-plane origin instead of the Vite browser origin for local upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "http://localhost:5173", "http://localhost:3000");
  expect(command).toContain("http://localhost:3000/api/workers/installer?");
  expect(command).toContain("connectOrigin=http%3A%2F%2Flocalhost%3A3000");
  expect(command).toContain("-ControlPlaneUrl 'http://localhost:3000'");
  expect(command).not.toContain("localhost:5173");
});

test("uses the control-plane installer endpoint for production upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example");
  expect(command).toContain("https://control.example/api/workers/installer?audience=windows-x64&upgrade=true&connectOrigin=https%3A%2F%2Fcontrol.example");
  expect(command).not.toContain("releases/latest/download");
});
test("renders upgrade preparation errors outside the closed action confirmation dialog", async () => {
  const source = await Bun.file(new URL("./WorkerActions.tsx", import.meta.url)).text();
  expect(source).toContain("upgradeError");
  expect(source).toContain('{upgradeError && <p className="inline-error" role="alert">{upgradeError}</p>}');
});

test("uses TLS for production control-plane installer downloads", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example", "https://control.example");
  expect(command).toContain("--proto '=https' --tlsv1.3");
  expect(command).not.toContain("releases/latest/download");
});