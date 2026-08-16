import { describe, expect, test } from "bun:test";
import { queryKeyMatchesInvalidation } from "./useDashboardInvalidations.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";

describe("dashboard invalidation query mapping", () => {
  test("matches organization resources and run detail aliases", () => {
    expect(queryKeyMatchesInvalidation(["org", organizationId, "overview", "24h"], organizationId, ["overview"])).toBe(true);
    expect(queryKeyMatchesInvalidation(["org", organizationId, "run", "run-1"], organizationId, ["runs"])).toBe(true);
    expect(queryKeyMatchesInvalidation(["org", organizationId, "runs", "failure"], organizationId, ["runs"])).toBe(true);
  });

  test("does not cross organization boundaries", () => {
    expect(queryKeyMatchesInvalidation(["org", "00000000-0000-4000-8000-000000000002", "runs"], organizationId, ["runs"])).toBe(false);
  });

  test("maps global worker and pool queries", () => {
    expect(queryKeyMatchesInvalidation(["workers", "global"], organizationId, ["workers"])).toBe(true);
    expect(queryKeyMatchesInvalidation(["pools", "global"], organizationId, ["pools"])).toBe(true);
  });
});
