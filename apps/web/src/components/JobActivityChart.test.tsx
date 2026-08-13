import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JobActivityChart } from "./JobActivityChart.tsx";

const points = [{ bucket: "2026-08-12T10:00:00.000Z", pending: 2, running: 1 }];

test("renders pending and running series in the activity chart", () => {
  const html = renderToStaticMarkup(<JobActivityChart points={points} />);
  expect(html).toContain("Pending jobs");
  expect(html).toContain("Running jobs");
});

test("renders an explicit empty state", () => {
  expect(renderToStaticMarkup(<JobActivityChart points={[]} />)).toContain("No job activity in this window.");
});
