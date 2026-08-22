import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateMasterKey } from "./control-plane-setup.ts";

describe("control-plane secret files", () => {
  test("creates a durable 0600 master key and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitesmith-setup-"));
    const first = await loadOrCreateMasterKey(root);
    const second = await loadOrCreateMasterKey(root);
    expect(first).toHaveLength(44);
    expect(second).toBe(first);
    if (process.platform !== "win32") expect((await stat(join(root, "app_master_key"))).mode & 0o777).toBe(0o600);
  });

  test("does not replace a malformed existing key", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitesmith-setup-"));
    const path = join(root, "app_master_key");
    await writeFile(path, "not-a-key", { mode: 0o600 });
    await expect(loadOrCreateMasterKey(root)).rejects.toThrow("invalid key");
    expect(await readFile(path, "utf8")).toBe("not-a-key");
  });
});
