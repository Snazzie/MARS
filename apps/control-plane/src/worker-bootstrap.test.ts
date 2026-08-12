import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { initializeWorkerBootstrap, rotateWorkerBootstrap, verifyWorkerBootstrap } from "./worker-bootstrap.ts";

type Row = { codeHash: Buffer; generation: number; createdAt: string; rotatedAt: string | null };
type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Row[];

function fakeDb(): Sql<{}> {
  let row: Row | null = null;
  const query: Query = (strings, ...values) => {
    const text = strings.join("?");
    if (text.includes("insert into worker_bootstrap_credentials")) { if (row) throw new Error("duplicate"); row = { codeHash: values[0] as Buffer, generation: 1, createdAt: new Date().toISOString(), rotatedAt: null }; return [row]; }
    if (text.includes("select code_hash")) return row ? [row] : [];
    if (text.includes("select generation")) return row ? [row] : [];
    if (text.includes("update worker_bootstrap_credentials")) { row = { ...row!, codeHash: values[0] as Buffer, generation: row!.generation + 1, rotatedAt: new Date().toISOString() }; return [row]; }
    return [];
  };
  const db = query as unknown as Sql<{}>;
  (db as unknown as { begin: (fn: (tx: Sql<{}>) => unknown) => Promise<unknown> }).begin = async (fn) => fn(db);
  return db;
}

describe("stable worker bootstrap credential", () => {
  test("reveals once, stores only hash, and rotation invalidates", async () => {
    const db = fakeDb();
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
    await expect(rotateWorkerBootstrap(fakeDb(), "admin-1")).rejects.toThrow("bootstrap credential is not initialized");
  });
});
