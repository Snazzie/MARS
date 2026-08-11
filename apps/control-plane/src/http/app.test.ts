import { describe, expect, test } from "bun:test";
import { createControlPlaneApp } from "./app.ts";
import { fakeHttpDeps } from "./test-deps.ts";

const app = createControlPlaneApp(fakeHttpDeps());

describe("control-plane HTTP boundary", () => {
  test("serves health only below /api", async () => {
    expect((await app.request("/api/healthz")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(404);
  });

  test("never serves the SPA for an unknown API route", async () => {
    const response = await app.request("/api/not-a-route");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("serves client routes outside the API namespace", async () => {
    expect((await app.request("/settings")).status).toBe(200);
  });
});
