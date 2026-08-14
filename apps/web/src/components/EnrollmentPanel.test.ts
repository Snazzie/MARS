import { expect, test } from "bun:test";
import { buildInstallerCommand, buildInstallerCommands, connectedEnrollmentWorker, connectionSnapshot, normalizeControlPlaneUrls } from "./EnrollmentPanel.tsx";
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
test("accepts adapter IP and custom HTTP URLs", () => { expect(buildInstallerCommand("http://192.168.64.1:3000/api/workers/installer?audience=linux-x64", "linux-x64")).toContain("--proto '=http'"); expect(normalizeControlPlaneUrls(["http://192.168.64.1:3000", "https://runner.example.com/", "bad", "http://192.168.64.1:3000"])).toEqual(["http://192.168.64.1:3000", "https://runner.example.com"]); });
test("adds the insecure opt-in to copied Windows commands over HTTP", () => { const command = buildInstallerCommand("http://localhost:3000/api/workers/installer?audience=windows-x64", "windows-x64", "Abc_-9"); expect(command).toContain("-AllowInsecureHttp"); });
test("rejects unsupported installers", () => { expect(() => buildInstallerCommand(url, "sol-x64" as never)).toThrow(); });
test("detects only workers that became online after enrollment started", () => {
  const before = connectionSnapshot([
    { id: "existing-online", connectionState: "online" },
    { id: "existing-offline", connectionState: "offline" },
  ]);
  expect(connectedEnrollmentWorker(before, [
    { id: "existing-online", connectionState: "online" },
    { id: "existing-offline", connectionState: "online" },
  ])).toBe("existing-offline");
  expect(connectedEnrollmentWorker(before, [
    { id: "existing-online", connectionState: "online" },
    { id: "existing-offline", connectionState: "offline" },
    { id: "new-worker", connectionState: "online" },
  ])).toBe("new-worker");
  expect(connectedEnrollmentWorker(before, [
    { id: "existing-online", connectionState: "online" },
  ])).toBeNull();
});
test("renders enrollment inline without dialog lifecycle", async () => {
  const source = await Bun.file(new URL("./EnrollmentPanel.tsx", import.meta.url)).text();
  expect(source).not.toContain("<dialog");
  expect(source).not.toContain("showModal");
  expect(source).toContain("Worker connected");
  expect(source).toContain("Enroll another worker");
  expect(source).toContain('label="Retry"');
});
