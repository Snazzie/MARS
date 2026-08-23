import { expect, test } from "bun:test";
import { workerHealthQueryOptions } from "./useWorkerHealth.ts";

test("disables worker health while the panel is collapsed", () => {
  expect(workerHealthQueryOptions("worker-1", false)).toMatchObject({
    queryKey: ["worker-health", "worker-1"],
    enabled: false,
    refetchInterval: false,
  });
});

test("enables independent worker health polling while the panel is expanded", () => {
  const options = workerHealthQueryOptions("worker-1", true);
  expect(options).toMatchObject({
    queryKey: ["worker-health", "worker-1"],
    enabled: true,
    refetchInterval: 3000,
  });
  expect(options.queryKey).not.toEqual(["org", "all", "workers"]);
});
