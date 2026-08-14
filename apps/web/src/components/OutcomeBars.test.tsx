import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OutcomeBars } from "./OutcomeBars.tsx";

const outcomes = [
  { outcome: "queued" as const, platforms: { macos: 2, ubuntu: 1, windows: 0, other: 0 } },
  { outcome: "running" as const, platforms: { macos: 0, ubuntu: 0, windows: 1, other: 0 } },
  { outcome: "completed" as const, platforms: { macos: 0, ubuntu: 3, windows: 0, other: 1 } },
  { outcome: "failed" as const, platforms: { macos: 0, ubuntu: 0, windows: 0, other: 0 } },
];
test("renders TanStack's SVG stacked chart with platform legend", () => {
  const html = renderToStaticMarkup(<OutcomeBars outcomes={outcomes} />);
  expect(html).toContain("<svg");
  expect(html).toContain("Platform");
  expect(html).toContain("Queued");
  expect(html).toContain("Completed");
  expect(html).toContain("macOS");
  expect(html).toContain("Ubuntu");
  expect(html).toContain("Windows");
  expect(html).toContain("Other");
  expect(html).toContain("Queued macOS: 2");
});

test("renders the empty state when all outcome counts are zero", () => {
  const empty = outcomes.map((value) => ({ ...value, platforms: { macos: 0, ubuntu: 0, windows: 0, other: 0 } }));
  expect(renderToStaticMarkup(<OutcomeBars outcomes={empty} />)).toContain("No outcomes recorded yet.");
});
