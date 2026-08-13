import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewPeriodControl, overviewPeriodLabels } from "./OverviewPage.tsx";

test("period control exposes all supported overview windows", () => {
  const markup = renderToStaticMarkup(<OverviewPeriodControl value="24h" onChange={() => {}} />);
  expect(markup).toContain('aria-label="Overview time window"');
  expect(markup).toContain('value="24h"');
  expect(markup).toContain('value="7d"');
  expect(markup).toContain('value="30d"');
  expect(markup).toContain('checked=""');
  expect(overviewPeriodLabels["30d"]).toBe("30 days");
});
