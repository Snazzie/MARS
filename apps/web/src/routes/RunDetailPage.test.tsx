import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("run detail route does not render the legacy duplicate header", () => {
  const source = readFileSync(new URL("./RunDetailPage.tsx", import.meta.url), "utf8");
  expect(source).not.toContain("className=\"page-header\"");
  expect(source).toContain("className=\"back-link\"");
  expect(source).toContain("className=\"sr-only\"");
});
