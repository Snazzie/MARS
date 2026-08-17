import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("run detail page uses the generated authenticated route context", () => {
  const source = readFileSync(new URL("./RunDetailPage.tsx", import.meta.url), "utf8");
  expect(source).toContain('useParams({ from: "/_authenticated/runs/$runId" })');
  expect(source).toContain('useSearch({ from: "/_authenticated/runs/$runId" })');
  expect(source).not.toContain("/dashboard-gate/dashboard/runs/$runId");
});

test("run detail route does not render the legacy duplicate header", () => {
  const source = readFileSync(new URL("./RunDetailPage.tsx", import.meta.url), "utf8");
  expect(source).not.toContain("className=\"page-header\"");
  expect(source).toContain("className=\"back-link\"");
  expect(source).toContain("className=\"sr-only\"");
});
test("runs parent route renders its child outlet", () => {
  const source = readFileSync(new URL("../file-routes/_authenticated/runs.tsx", import.meta.url), "utf8");
  expect(source).toContain("Outlet");
  expect(source).toContain("<Outlet />");
});
