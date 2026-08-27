import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDevLock,
  devLockPath,
  devPorts,
  parseDevOptions,
  windowsPortCleanupScript,
} from "./dev-ports.ts";

test("parses only the opt-in kill flag", () => {
  expect(parseDevOptions([])).toEqual({ kill: false });
  expect(parseDevOptions(["--kill"])).toEqual({ kill: true });
  expect(() => parseDevOptions(["--unknown"])).toThrow("Unknown dev option");
});

test("resolves and validates unique development ports", () => {
  expect(devPorts({})).toEqual([3000, 5173]);
  expect(devPorts({ PORT: "4100", WEB_PORT: "4100" })).toEqual([4100]);
  expect(() => devPorts({ PORT: "0" })).toThrow("PORT must be an integer between 1 and 65535");
  expect(() => devPorts({ WEB_PORT: "abc" })).toThrow("WEB_PORT must be an integer between 1 and 65535");
});

test("Windows cleanup targets only configured listeners and excludes its parent", () => {
  const script = windowsPortCleanupScript([3000, 5173], 4242);
  expect(script).toContain("@(3000,5173)");
  expect(script).toContain("$processId -ne 4242");
  expect(script).toContain("Stop-Process -Id $processId -Force");
  expect(script).toContain("Ports still occupied");
});

test("rejects a second live owner with the recorded PID", () => {
  const repository = mkdtempSync(join(tmpdir(), "mars-dev-test-"));
  const first = acquireDevLock(repository, process.pid);
  try {
    expect(() => acquireDevLock(repository, process.pid + 1)).toThrow(`PID ${process.pid}`);
  } finally {
    first.release();
    rmSync(repository, { recursive: true, force: true });
  }
});
test("reclaims a dead owner lock", () => {
  const repository = mkdtempSync(join(tmpdir(), "mars-dev-test-"));
  const path = devLockPath(repository);
  mkdirSync(path);
  writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: 999999999 }));
  const lock = acquireDevLock(repository, process.pid);
  expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf8"))).toEqual({ pid: process.pid });
  lock.release();
  rmSync(repository, { recursive: true, force: true });
});

test("release cannot delete a lock reassigned to another PID", () => {
  const repository = mkdtempSync(join(tmpdir(), "mars-dev-test-"));
  const lock = acquireDevLock(repository, process.pid);
  writeFileSync(join(lock.path, "owner.json"), JSON.stringify({ pid: process.pid + 1 }));
  lock.release();
  expect(readFileSync(join(lock.path, "owner.json"), "utf8")).toContain(String(process.pid + 1));
  rmSync(repository, { recursive: true, force: true });
});

test("package dev command delegates argument handling to the Bun entrypoint", async () => {
  const pkg = await Bun.file("package.json").json() as { scripts: Record<string, string> };
  expect(pkg.scripts.dev).toBe("bun run scripts/dev.ts");
  const launcher = await Bun.file("scripts/dev.ts").text();
  const ports = await Bun.file("scripts/dev-ports.ts").text();
  expect(launcher).toContain("await killRecordedDevSupervisor();\n  await killDevPortListeners");
  expect(ports).toContain("taskkill.exe");
  expect(ports).toContain("windowsPortCleanupScript(ports, process.pid)");
});
