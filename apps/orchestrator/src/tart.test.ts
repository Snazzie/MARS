import { expect, test } from "bun:test";
import { buildTartBootstrapArguments, buildTartRunnerArguments, buildTartSetArguments, resolveTartExecutable, TART_JIT_CONFIG_PATH } from "./tart.ts";
import * as tartModule from "./tart.ts";

const resources = (storageBytes: number) => ({ vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes, concurrency: 1 });

test("does not ask Tart to shrink a cloned base-image disk", () => {
  expect(buildTartSetArguments("lease-vm", resources(20 * 1024 ** 3), 50)).toEqual([
    "set", "lease-vm", "--cpu", "4", "--memory", "4096",
  ]);
});

test("expands a cloned disk when the lease requests more than the image", () => {
  expect(buildTartSetArguments("lease-vm", resources(60 * 1024 ** 3), 50)).toEqual([
    "set", "lease-vm", "--cpu", "4", "--memory", "4096", "--disk-size", "60",
  ]);
});

test("starts the VM with only a read-only bootstrap directory path", () => {
  const buildTartRunArguments = (tartModule as typeof tartModule & {
    buildTartRunArguments?: (vmName: string, bootstrapDirectory: string) => string[];
  }).buildTartRunArguments;
  expect(buildTartRunArguments).toBeFunction();
  expect(buildTartRunArguments!("lease-vm", "/private/tmp/whitesmith-bootstrap")).toEqual([
    "run",
    "--no-graphics",
    "--dir",
    "/private/tmp/whitesmith-bootstrap:ro",
    "lease-vm",
  ]);
});

test("copies bootstrap configuration from the read-only VM share without stdin attachment", () => {
  expect(buildTartBootstrapArguments("lease-vm")).toEqual([
    "exec",
    "lease-vm",
    "sh",
    "-c",
    `set -eu; umask 077; install -d -m 700 /tmp/whitesmith; rm -f ${TART_JIT_CONFIG_PATH}; cat "/Volumes/My Shared Files/jit-config" > ${TART_JIT_CONFIG_PATH}`,
  ]);
  expect(TART_JIT_CONFIG_PATH).toBe("/tmp/whitesmith/jit-config");
});

test("passes the Actions Runner root explicitly to the guest job agent", () => {
  expect(buildTartRunnerArguments("lease-vm")).toEqual([
    "exec",
    "lease-vm",
    "/usr/local/bin/whitesmith-job-agent",
    "bootstrap",
    "--config-file",
    TART_JIT_CONFIG_PATH,
    "--runner-root",
    "/opt/actions-runner",
  ]);
});

test("uses the installer-provided absolute Tart executable under launchd", () => {
  expect(resolveTartExecutable("/opt/homebrew/bin/tart")).toBe("/opt/homebrew/bin/tart");
  expect(resolveTartExecutable("")).toBe("tart");
});
