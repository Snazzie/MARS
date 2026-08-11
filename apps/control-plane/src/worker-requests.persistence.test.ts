import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { requestPendingWorker } from "./worker-requests.ts";

describe("pending worker persistence", () => {
  test("stores telemetry while leaving policy limits NULL", async () => {
    const queries: string[] = [];
    const queryValues: unknown[][] = [];
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => { const sql = strings.join(" "); queries.push(sql); queryValues.push(values); if (sql.includes("select code_hash")) return [{ codeHash: createHash("sha256").update(Buffer.from("A".repeat(43), "base64url")).digest() }]; if (sql.includes("select id,")) return []; if (sql.includes("returning id")) return [{ id: "00000000-0000-4000-8000-000000000003" }]; return []; };
    const input = { code: "A".repeat(43), platform: "linux-x64" as const, publicKey: "ed25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
    const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => { queries.push(strings.join(" ")); queryValues.push(values); return []; }) as unknown as Sql<{}>, { begin: async (fn: (tx: unknown) => unknown) => fn(tx) });
    const result = await requestPendingWorker(db, input);
    expect(result.status).toBe("created");
    const insertValues = queryValues.find((values, index) => queries[index].includes("insert into workers"));
    const insertIndex = queries.findIndex(query => query.includes("insert into workers"));
    expect(queries[insertIndex]).toContain(",null,");
    expect(insertValues).toContain(JSON.stringify({ doctor: input.doctor, capacity: input.capacity }));
  });
});
