import { expect, test } from "bun:test";
import { RUNS_REFRESH_INTERVAL_MS, runsQueryOptions } from "./RunsPage.tsx";

test("runs query polls live workflow state", () => {
  expect(runsQueryOptions("org-1").refetchInterval).toBe(RUNS_REFRESH_INTERVAL_MS);
});
