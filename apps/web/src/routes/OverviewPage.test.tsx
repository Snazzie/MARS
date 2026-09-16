import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewCostMetrics, OverviewPeriodControl, formatOverviewMicros, formatOverviewMinutes, overviewPeriodLabels, overviewQueryOptions } from "./OverviewPage.tsx";

test("period control exposes all supported overview windows", () => {
  const markup = renderToStaticMarkup(<OverviewPeriodControl value="24h" onChange={() => {}} />);
  expect(markup).toContain('aria-label="Overview time window"');
  expect(markup).toContain('value="24h"');
  expect(markup).toContain('value="7d"');
  expect(markup).toContain('value="30d"');
  expect(markup).toContain('checked=""');
  expect(overviewPeriodLabels["30d"]).toBe("30 days");
});

test("overview query polls only when aggregate invalidations are unavailable", () => {
  expect(overviewQueryOptions("org-1", "24h")).not.toHaveProperty("refetchInterval");
  expect(overviewQueryOptions("all", "24h")).toMatchObject({ refetchInterval: 5_000 });
});

const costSavings = { selfHostedMinutes: 1234, pricedMinutes: 1200, unpricedMinutes: 34, estimatedSavingsMicros: 9_000, currency: "USD" as const, latestRateEffectiveFrom: "2026-01-01" };

test("cost metrics disclose rounding, dated rates, and partial estimates", () => {
  const markup = renderToStaticMarkup(<OverviewCostMetrics costSavings={costSavings} />);
  expect(formatOverviewMinutes(1234)).toBe("1,234 min");
  expect(formatOverviewMicros(0)).toBe("$0.00");
  expect(formatOverviewMicros(1)).toBe("<$0.01");
  expect(formatOverviewMicros(10_000)).toBe("$0.01");
  expect(markup).toContain("Self-hosted minutes");
  expect(markup).toContain("Dated GitHub-hosted rates are applied by job completion date.");
  expect(markup).toContain("Each completed Mars job is rounded independently.");
  expect(markup).toContain("34 min could not be matched");
  expect(markup).toContain("Latest applied rate: Jan 1, 2026.");
});
