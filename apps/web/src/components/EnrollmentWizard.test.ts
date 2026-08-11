import { expect, test } from "bun:test";
import { buildInstallerCommand } from "./EnrollmentWizard.tsx";
const url = "https://runner.example.com/api/workers/installer?audience=linux-x64";
test("installer commands do not contain resource fields or enrollment code", () => { const command = buildInstallerCommand(url, "linux-x64", "Abc_-9"); expect(command).not.toContain("--code"); expect(command).not.toContain("Abc_-9"); expect(command).not.toContain("vcpu"); });
test("supports each installer audience", () => { expect(buildInstallerCommand(url, "linux-x64")).toContain("bash"); expect(buildInstallerCommand(url, "windows-x64")).toContain("powershell.exe"); expect(buildInstallerCommand(url, "macos-arm64")).toContain("zsh"); });
test("rejects unsupported and insecure installers", () => { expect(() => buildInstallerCommand(url, "sol-x64" as never)).toThrow(); expect(() => buildInstallerCommand("http://runner.example.com/install", "linux-x64")).toThrow(); });
