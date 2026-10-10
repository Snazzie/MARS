import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLeasePickupState, readLeasePickupState, writeLeasePickupInventory, writeLeasePickupState } from "./lease-pickup-state.ts";

describe("lease pickup state", () => {
  test("missing state accepts and atomic replacement is observed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mars-state-test-"));
    const path = join(directory, "lease-pickup.json");
    const controller = await openLeasePickupState(path);
    const changed = new Promise<boolean>(resolve => { controller.subscribe(resolve); });
    await writeLeasePickupState(path, false);
    await changed;
    expect(controller.acceptingLeases).toBe(false);
    await controller.close();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ paused: true, activeCount: 0 });
    await rm(directory, { recursive: true });
  });
  test("concurrent writes use distinct temporary files at the same timestamp", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mars-state-race-test-"));
    const path = join(directory, "lease-pickup.json");
    const originalNow = Date.now;
    try {
      Date.now = () => 123456789;
      await expect(Promise.all(Array.from({ length: 8 }, (_, index) =>
        writeLeasePickupState(path, index % 2 === 0, index),
      ))).resolves.toHaveLength(8);
      const finalState = JSON.parse(await readFile(path, "utf8"));
      expect(Array.from({ length: 8 }, (_, index) => ({ paused: index % 2 !== 0, activeCount: index }))).toContainEqual(finalState);
      expect(await readdir(directory)).toEqual(["lease-pickup.json"]);
    } finally {
      Date.now = originalNow;
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("inventory publication cannot overwrite a tray pause or resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mars-state-inventory-test-"));
    const path = join(directory, "lease-pickup.json");
    try {
      for (const acceptingLeases of [false, true]) {
        await writeLeasePickupState(path, acceptingLeases);
        await Promise.all([writeLeasePickupInventory(path, 2), writeLeasePickupInventory(path, 0)]);
        expect(await readLeasePickupState(path)).toBe(acceptingLeases);
        expect(JSON.parse(await readFile(`${path}.inventory.json`, "utf8"))).toEqual({ activeCount: 0 });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.skipIf(process.platform !== "win32")("inventory replacement waits for a Windows reader and preserves pause state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mars-state-locked-test-"));
    const path = join(directory, "lease-pickup.json");
    let reader: Subprocess<"pipe", "pipe", "inherit"> | undefined;
    try {
      await writeLeasePickupState(path, false);
      await writeLeasePickupInventory(path, 1);
      reader = Bun.spawn(["powershell.exe", "-NoProfile", "-Command",
        `$s=[IO.File]::Open('${path.replaceAll("'", "''")}.inventory.json',[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); try { Write-Output READY; [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $s.Dispose() }`,
      ], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      const lockedReader = reader;
      const ready = lockedReader.stdout.getReader();
      expect(new TextDecoder().decode((await ready.read()).value).trim()).toBe("READY");
      ready.releaseLock();
      await expect(writeLeasePickupInventory(path, 9)).rejects.toMatchObject({ code: "EPERM" });
      expect(JSON.parse(await readFile(`${path}.inventory.json`, "utf8"))).toEqual({ activeCount: 1 });
      expect((await readdir(directory)).sort()).toEqual(["lease-pickup.json", "lease-pickup.json.inventory.json"]);
      // Real time is required: the external Windows handle is unaffected by fake timers.
      const release = setTimeout(() => {
        lockedReader.stdin.write("\n");
        lockedReader.stdin.end();
      }, 100);
      try {
        await writeLeasePickupInventory(path, 2);
      } finally {
        clearTimeout(release);
      }
      expect(JSON.parse(await readFile(`${path}.inventory.json`, "utf8"))).toEqual({ activeCount: 2 });
      expect(await readLeasePickupState(path)).toBe(false);
      expect((await readdir(directory)).sort()).toEqual(["lease-pickup.json", "lease-pickup.json.inventory.json"]);
    } finally {
      if (reader) {
        reader.kill();
        await reader.exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("malformed state fails closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mars-state-test-"));
    const path = join(directory, "lease-pickup.json");
    await writeFile(path, "{\"paused\":\"no\"}");
    const controller = await openLeasePickupState(path);
    expect(controller.acceptingLeases).toBe(false);
    await controller.close();
    await rm(directory, { recursive: true });
  });
});
