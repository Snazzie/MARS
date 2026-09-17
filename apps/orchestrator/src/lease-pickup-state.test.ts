import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
