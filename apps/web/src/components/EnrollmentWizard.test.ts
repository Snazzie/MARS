import { expect, test } from "bun:test";
import { getWorkerBootstrapStatus } from "../api.ts";
import { buildInstallerCommand, buildInstallerCommands, openEnrollmentDialog } from "./EnrollmentWizard.tsx";
const url = "https://runner.example.com/api/workers/installer?audience=linux-x64";
test("bootstrap status contract includes initialization generation and timestamps", () => {
  const status = {
    initialized: true,
    generation: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    rotatedAt: "2026-01-02T00:00:00.000Z",
  };
  expect(status.initialized).toBe(true);
  expect(status.generation).toBe(3);
});
test("loads bootstrap status before opening the enrollment dialog", async () => {
  const events: string[] = [];
  const status = await openEnrollmentDialog(
    async () => {
      events.push("status");
      return { initialized: true };
    },
    () => events.push("dialog"),
  );

  expect(status).toEqual({ initialized: true });
  expect(events).toEqual(["status", "dialog"]);
});

test("installer commands include the one-use enrollment code", () => { const command = buildInstallerCommand(url, "linux-x64", "Abc_-9"); expect(command).toContain("--code"); expect(command).toContain("Abc_-9"); expect(command).not.toContain("vcpu"); });
test("streams the macOS installer into user-scoped zsh", () => {
  const installer = "https://runner.example.com/api/workers/installer?audience=macos-arm64";
  expect(buildInstallerCommand(installer, "macos-arm64", "Abc_-9")).toBe(
    "curl --fail --proto '=https' --tlsv1.3 'https://runner.example.com/api/workers/installer?audience=macos-arm64' | zsh -s -- --code 'Abc_-9'",
  );
});
test("supports each installer audience", () => { expect(buildInstallerCommand(url, "linux-x64")).toContain("bash"); expect(buildInstallerCommand(url, "windows-x64")).toContain("powershell.exe"); expect(buildInstallerCommand(url, "macos-arm64")).toContain("zsh"); });

test("builds only the selected platform installer command", () => {
  const commands = buildInstallerCommands("https://runner.example.com", "windows-x64", "one-use-code");
  expect(commands).toHaveLength(1);
  expect(commands[0]?.label).toBe("Windows x64");
  expect(commands[0]?.command).toContain("powershell.exe");
  expect(commands[0]?.command).toContain("-Code");
  expect(commands[0]?.command).toContain("one-use-code");
});
test("rejects unsupported and insecure installers", () => { expect(() => buildInstallerCommand(url, "sol-x64" as never)).toThrow(); expect(() => buildInstallerCommand("http://runner.example.com/install", "linux-x64")).toThrow(); });
