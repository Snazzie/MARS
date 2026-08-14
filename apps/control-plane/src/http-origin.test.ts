import { expect, test } from "bun:test";
import { browserLocation, httpOrigin } from "./http-origin.ts";

test("accepts an HTTP origin and removes only a trailing slash", () => {
  expect(httpOrigin("PUBLIC_BASE_URL", "http://localhost:3000/")).toBe("http://localhost:3000");
});

test.each([
  "ftp://localhost:3000",
  "http://user:pass@localhost:3000",
  "http://localhost:3000/api",
  "http://localhost:3000/?query=yes",
  "http://localhost:3000/#fragment",
])("rejects non-origin URL %s", (value) => {
  expect(() => httpOrigin("BROWSER_BASE_URL", value)).toThrow("BROWSER_BASE_URL must be an absolute HTTP(S) origin");
});

test("resolves repository-owned browser paths against the browser origin", () => {
  expect(browserLocation("http://localhost:5173", "/onboarding?github=repository-selection-required"))
    .toBe("http://localhost:5173/onboarding?github=repository-selection-required");
});
