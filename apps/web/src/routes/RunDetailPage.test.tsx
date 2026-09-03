import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { scrollToJobFragment } from "./RunDetailPage.tsx";

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
test("scrolls to a matching job fragment after details load", () => {
  const source = readFileSync(new URL("./RunDetailPage.tsx", import.meta.url), "utf8");
  expect(source).toContain("useEffect(() => {");
  expect(source).toContain("if (typeof window === \"undefined\" || typeof document === \"undefined\" || !query.data) return;");
  expect(source).toContain("scrollToJobFragment(window.location.hash, document);");
  expect(source).toContain("if (!hash.startsWith(\"#job-\")) return;");
  expect(source).toContain("targetDocument.getElementById(jobId)?.scrollIntoView?.({ block: \"start\" });");
  expect(source).toContain("}, [query.data, runId]);");
});

test("scrolls a loaded job fragment target to the top", () => {
  const window = new Window();
  const target = window.document.createElement("section");
  target.id = "job-job-1";
  let receivedOptions: ScrollIntoViewOptions | undefined;
  target.scrollIntoView = (options?: ScrollIntoViewOptions) => {
    receivedOptions = options;
  };
  window.document.body.append(target);

  scrollToJobFragment("#job-job-1", window.document);

  expect(receivedOptions).toEqual({ block: "start" });
});
test("runs parent route renders its child outlet", () => {
  const source = readFileSync(new URL("../file-routes/_authenticated/runs.tsx", import.meta.url), "utf8");
  expect(source).toContain("Outlet");
  expect(source).toContain("<Outlet />");
});
