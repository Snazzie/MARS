import { expect, test } from "bun:test";
import { DashboardHealthResponse, DashboardWorkerMutationResponse, DashboardEndpoint, WorkerConfiguration } from "./dashboard-api.ts";

test("parses worker configuration response", () => {
  const response = DashboardWorkerMutationResponse.parse({
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
    commandId: "00000000-0000-4000-8000-000000000001",
  });
  expect(response.revision).toHaveLength(64);
});

test("rejects malformed health response", () => {
  expect(() => DashboardHealthResponse.parse({ ok: "yes" })).toThrow();
});

test("keeps endpoint request and response schemas type-linked", () => {
  const endpoint = {
    request: WorkerConfiguration,
    response: DashboardWorkerMutationResponse,
  } satisfies DashboardEndpoint<typeof WorkerConfiguration, typeof DashboardWorkerMutationResponse>;
  expect(endpoint.request).toBe(WorkerConfiguration);
  expect(endpoint.response).toBe(DashboardWorkerMutationResponse);
});
