import { expect, test } from "bun:test";
import { workerHealthQueryOptions } from "./useWorkerHealth.ts";

test("enables worker health polling for a valid worker ID", () => {
  const options = workerHealthQueryOptions("worker-1");
  expect(options).toMatchObject({
    queryKey: ["worker-health", "worker-1"],
    enabled: true,
    refetchInterval: 3000,
  });
  expect(options.queryKey).not.toEqual(["org", "all", "workers"]);
});

test("disables worker health when the worker ID is empty", () => {
  expect(workerHealthQueryOptions("")).toMatchObject({
    queryKey: ["worker-health", ""],
    enabled: false,
    refetchInterval: 3000,
  });
});
