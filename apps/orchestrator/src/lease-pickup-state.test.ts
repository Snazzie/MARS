import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLeasePickupState, writeLeasePickupState } from "./lease-pickup-state.ts";

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
