import { expect, test } from "bun:test";
import { buildInstallerCommand } from "./EnrollmentWizard.tsx";

const code = "Abc_-9";
const metacharCode = "Abc'$(printf hacked)";
const localMacUrl = "http://localhost:3000/api/workers/installer?audience=macos-arm64";
const httpsLinuxUrl = "https://runner.example.com/api/workers/installer?audience=linux-x64";
const httpsWindowsUrl = "https://runner.example.com/api/workers/installer?audience=windows-x64";

test("macOS embeds the code only in the final zsh invocation", () => {
  const command = buildInstallerCommand(localMacUrl, "macos-arm64", code);
  expect(command).toContain(`zsh "$whitesmith_installer" --code '${code}'`);
  expect(command).not.toContain(metacharCode);
});

test("Linux embeds the code only in the final bash invocation", () => {
  expect(buildInstallerCommand(httpsLinuxUrl, "linux-x64", code))
    .toContain(`bash "$whitesmith_installer" --code '${code}'`);
});

test("Windows embeds the code in the final PowerShell invocation", () => {
  expect(buildInstallerCommand(httpsWindowsUrl, "windows-x64", code))
    .toContain(`-Code '${code}'`);
});

test("rejects unsupported audience, insecure URL, and empty code", () => {
  expect(() => buildInstallerCommand(httpsLinuxUrl, "sol-x64" as never, code)).toThrow();
  expect(() => buildInstallerCommand("http://runner.example.com/install", "linux-x64", code)).toThrow();
  expect(() => buildInstallerCommand(httpsLinuxUrl, "linux-x64", "")).toThrow();
});
test("quotes shell metacharacters without executing them", () => {
  const command = buildInstallerCommand(httpsLinuxUrl, "linux-x64", metacharCode);
  expect(command).toContain(`--code 'Abc'"'"'$(printf hacked)'`);
});

test("public HTTPS installers remain pinned to HTTPS and TLS 1.3", () => {
  const command = buildInstallerCommand(httpsLinuxUrl, "linux-x64", code);
  expect(command).toContain("--proto '=https'");
  expect(command).toContain("--tlsv1.3");
  expect(command).toContain('bash "$whitesmith_installer"');
});

test("Windows installers generate a PowerShell download and execution block", () => {
  const command = buildInstallerCommand(httpsWindowsUrl, "windows-x64", code);

  expect(command).toContain("curl.exe");
  expect(command).toContain("$whitesmithInstaller");
  expect(command).toContain("powershell.exe -NoProfile -ExecutionPolicy Bypass -File $whitesmithInstaller");
  expect(command).not.toContain("| sh");
});
