import { expect, test } from "bun:test";
import { buildInstallerCommand, buildInstallerCommands, connectedEnrollmentWorker, connectionSnapshot, normalizeControlPlaneUrls } from "./EnrollmentPanel.tsx";
const url = "https://github.com/Snazzie/Mars/releases/latest/download/install-worker-linux-x64.sh";
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

test("installer commands include the one-use enrollment code and selected control-plane URL", () => {
  const command = buildInstallerCommand(url, "linux-x64", "Abc_-9", "https://control.example/");
  expect(command).toContain("https://github.com/Snazzie/Mars/releases/latest/download/install-worker-linux-x64.sh");
  expect(command).toContain("--control-plane-url 'https://control.example'");
  expect(command).toContain("--code 'Abc_-9'");
  expect(command).not.toContain("vcpu");
});
test("downloads the macOS release installer to a temporary file and cleans it after --code execution", () => {
  const installer = "https://github.com/Snazzie/Mars/releases/latest/download/install-worker-macos-arm64.sh";
  const command = buildInstallerCommand(installer, "macos-arm64", "Abc_-9", "https://control.example");
  expect(command).toContain("mktemp");
  expect(command).toContain("zsh \"$marsInstaller\" --control-plane-url 'https://control.example' --code 'Abc_-9'");
  expect(command).toContain("trap");
  expect(command).toContain("curl --fail --proto '=https' --tlsv1.3");
});
test("aborts before invoking Linux/macOS installer when curl fails", () => {
  for (const [audience, shell] of [["linux-x64", "bash"], ["macos-arm64", "zsh"]] as const) {
    const command = buildInstallerCommand(`https://github.com/Snazzie/Mars/releases/latest/download/install-worker-${audience}.sh`, audience, "Abc_-9", "https://control.example");
    expect(command).not.toContain("worker-v0.1.0");
    expect(command.startsWith("set -e\n")).toBe(true);
    expect(command.indexOf("\ncurl ")).toBeLessThan(command.indexOf(`\nPUBLIC_BASE_URL=`));
    expect(command.indexOf(`\nPUBLIC_BASE_URL=`)).toBeLessThan(command.indexOf(`${shell} "$marsInstaller"`));
  }
});
test("supports each immutable release installer asset", () => {
  for (const audience of ["linux-x64", "windows-x64", "macos-arm64"] as const) {
    const command = buildInstallerCommands("https://control.example", audience, "code")[0]?.command ?? "";
    expect(command).toContain("https://github.com/Snazzie/Mars/releases/latest/download/");
    expect(command).not.toContain("worker-v0.1.0");
  }
});
test("uses the local control-plane installer endpoint in development", () => {
  const command = buildInstallerCommands("http://localhost:3000", "windows-x64", "code", true)[0]?.command ?? "";
  expect(command).toContain("http://localhost:3000/api/workers/installer?");
  expect(command).toContain("audience=windows-x64");
  expect(command).toContain("runtime=container");
  expect(command).toContain("connectOrigin=http%3A%2F%2Flocalhost%3A3000");
  expect(command).toContain("-ControlPlaneUrl 'http://localhost:3000'");
  expect(command).not.toContain("github.com/Snazzie/Mars/releases");
});
test("keeps the GitHub release installer URL in production", () => {
  const command = buildInstallerCommands("https://control.example", "windows-x64", "code", false)[0]?.command ?? "";
  expect(command).toContain("https://github.com/Snazzie/Mars/releases/latest/download/install-worker-windows-x64.ps1");
});
test("builds only the selected platform installer command", () => {
  const commands = buildInstallerCommands("https://control.example", "windows-x64", "one-use-code");
  expect(commands).toHaveLength(1);
  expect(commands[0]?.label).toBe("Windows x64 (container)");
  expect(commands[0]?.command).toContain("powershell.exe");
  expect(commands[0]?.command).toContain("-ControlPlaneUrl 'https://control.example'");
  expect(commands[0]?.command).toContain("-Code 'one-use-code'");
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
