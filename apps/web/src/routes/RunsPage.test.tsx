import { expect, test } from "bun:test";
import { runsQueryOptions } from "./RunsPage.tsx";

test("runs query relies on durable invalidations instead of polling", () => {
  expect(runsQueryOptions("org-1")).not.toHaveProperty("refetchInterval");
});
