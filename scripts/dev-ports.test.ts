import { expect, test } from "bun:test";
import { devPorts, parseDevOptions, windowsPortCleanupScript } from "./dev-ports.ts";

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

test("package dev command delegates argument handling to the Bun entrypoint", async () => {
  const pkg = await Bun.file("package.json").json() as { scripts: Record<string, string> };
  expect(pkg.scripts.dev).toBe("bun run scripts/dev.ts");
});
