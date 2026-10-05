import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { initializeWorkerBootstrap, rotateWorkerBootstrap, verifyWorkerBootstrap } from "./worker-bootstrap.ts";

function database() {
  let hash: Buffer | null = null;
  let generation = 0;
  const db = preparedTestDatabase((name, parameters) => {
    if (name === "worker_bootstrap_initialize") {
      if (hash) throw new Error("duplicate");
      hash = parameters.codeHash as Buffer;
      generation = 1;
      return [{ generation, createdAt: new Date(), rotatedAt: null }];
    }
    if (name === "worker_bootstrap_lock") return hash ? [{ generation }] : [];
    if (name === "worker_bootstrap_rotate") {
      hash = parameters.codeHash as Buffer;
      generation += 1;
      return [{ generation, createdAt: new Date(), rotatedAt: new Date() }];
    }
    if (name === "worker_bootstrap_status") return hash ? [{ generation, createdAt: new Date(), rotatedAt: null }] : [];
    if (name === "worker_bootstrap_verify") return hash ? [{ codeHash: hash }] : [];
    return [];
  });
  return db;
}

test("reveals once, stores only hash, and rotation invalidates", async () => {
  const db = database();
  const reveal = await initializeWorkerBootstrap(db, "admin-1");
  expect(reveal.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await verifyWorkerBootstrap(db, reveal.code)).toBe(true);
  await expect(initializeWorkerBootstrap(db, "admin-1")).rejects.toThrow("already initialized");
  const rotated = await rotateWorkerBootstrap(db, "admin-2");
  expect(rotated.code).not.toBe(reveal.code);
  expect(await verifyWorkerBootstrap(db, reveal.code)).toBe(false);
  expect(await verifyWorkerBootstrap(db, rotated.code)).toBe(true);
});

test("rejects rotation before initialization", async () => {
  await expect(rotateWorkerBootstrap(database(), "admin-1")).rejects.toThrow("bootstrap credential is not initialized");
});
