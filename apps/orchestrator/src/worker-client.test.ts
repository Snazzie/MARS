import { expect, test } from "bun:test";
import { retryControlPlaneOperation } from "./worker-client.ts";

test("retries transient control-plane failures until the operation succeeds", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await retryControlPlaneOperation(
    "test operation",
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("connection refused") as Error & { code: string };
        error.code = "ECONNREFUSED";
        throw error;
      }
      return "ready";
    },
    async (milliseconds) => { sleeps.push(milliseconds); },
  );

  expect(result).toBe("ready");
  expect(attempts).toBe(3);
  expect(sleeps).toEqual([1_000, 1_000]);
});

test("does not sleep after an immediately successful control-plane operation", async () => {
  const sleeps: number[] = [];
  await expect(retryControlPlaneOperation("test operation", async () => 42, async (milliseconds) => { sleeps.push(milliseconds); })).resolves.toBe(42);
  expect(sleeps).toEqual([]);
});
