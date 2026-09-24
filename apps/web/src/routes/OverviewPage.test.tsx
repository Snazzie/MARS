import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportingPeriodControl, reportingPeriodLabels } from "../components/ReportingPeriodControl.tsx";
import { GithubRunnerCostDisclosure } from "../components/GithubRunnerCostDisclosure.tsx";
import { formatMinutes, formatUsdMicros } from "../format.ts";
import { ControlPlaneStatus } from "./OverviewPage.tsx";

test("period control exposes all supported reporting windows", () => {
  const markup = renderToStaticMarkup(<ReportingPeriodControl value="24h" onChange={() => {}} label="Overview time window" />);
  expect(markup).toContain('aria-label="Overview time window"');
  expect(markup).toContain('value="24h"');
  expect(markup).toContain('value="7d"');
  expect(markup).toContain('value="30d"');
  expect(markup).toContain('checked=""');
  expect(reportingPeriodLabels["30d"]).toBe("30 days");
});
test("overview explains dispatch blockers without equating healthy reconciliation to available capacity", () => {
  const markup = renderToStaticMarkup(<ControlPlaneStatus status={{
    state: "healthy", lastReconciledAt: "2026-09-24T02:17:00.000Z", queued: 3, reserved: 1,
    reasons: [{ code: "worker_runtime_not_ready", count: 2 }],
  }} />);
  expect(markup).toContain("Reconciliation healthy");
  expect(markup).toContain("3 queued jobs inspected");
  expect(markup).toContain("1 lease dispatched");
  expect(markup).toContain("Worker runtime or image is not ready");
  expect(markup).toContain("existing leases are excluded");
});


test("shared cost formatting and disclosure preserve money boundaries", () => {
  const costSavings = { selfHostedMinutes: 1234, pricedMinutes: 1200, unpricedMinutes: 34, estimatedSavingsMicros: 9_000, currency: "USD" as const, latestRateEffectiveFrom: "2026-01-01" };
  const markup = renderToStaticMarkup(<GithubRunnerCostDisclosure costSavings={costSavings} />);
  expect(formatMinutes(1234)).toBe("1,234 min");
  expect(formatUsdMicros(0)).toBe("$0.00");
  expect(formatUsdMicros(1)).toBe("<$0.01");
  expect(formatUsdMicros(10_000)).toBe("$0.01");
  expect(markup).toContain("Dated GitHub-hosted rates are applied by job completion date.");
  expect(markup).toContain("Each completed Mars job is rounded independently.");
  expect(markup).toContain("34 min could not be matched");
  expect(markup).toContain("Latest applied rate: Jan 1, 2026.");
});
