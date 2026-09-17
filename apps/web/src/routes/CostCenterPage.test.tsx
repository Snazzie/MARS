import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BreakdownTable, Summary, formatMinutesBreakdown, formatPlatform, formatRunner } from "./CostCenterPage.tsx";
import { CostCenterPriceChart } from "../components/CostCenterPriceChart.tsx";
import { GithubRunnerCostDisclosure } from "../components/GithubRunnerCostDisclosure.tsx";

const savings = { selfHostedMinutes: 7, pricedMinutes: 5, unpricedMinutes: 2, estimatedSavingsMicros: 110_000, currency: "USD" as const, latestRateEffectiveFrom: "2026-01-01" };
const points = [{ date: "2026-01-01", estimatedSavingsMicros: 50_000 }, { date: "2026-01-02", estimatedSavingsMicros: 60_000 }];
const rows = [{ organizationId: "org-1", repositoryId: "repo-1", repositoryName: "acme/app", platform: "windows-x64", requestedVcpu: 3, githubRunnerSku: "windows_4_core", githubRunnerVcpu: 4, jobCount: 2, selfHostedMinutes: 5, pricedMinutes: 5, unpricedMinutes: 0, estimatedSavingsMicros: 110_000 }, { organizationId: "org-1", repositoryId: "repo-2", repositoryName: "acme/tools", platform: "linux-x64", requestedVcpu: 128, githubRunnerSku: null, githubRunnerVcpu: null, jobCount: 1, selfHostedMinutes: 2, pricedMinutes: 0, unpricedMinutes: 2, estimatedSavingsMicros: 0 }];

test("renders Cost Center populated rows and disclosure", () => {
  const markup = renderToStaticMarkup(<><Summary costSavings={savings} /><GithubRunnerCostDisclosure costSavings={savings} /><BreakdownTable rows={rows} /></>);
  expect(markup).toContain("Estimated GitHub-hosted retail cost avoided");
  expect(markup).toContain("$0.11");
  expect(markup).toContain("Cost Center repository and comparable GitHub runner breakdown");
  expect(markup).toContain("windows_4_core · 4 vCPU");
  expect(markup).toContain("No comparable GitHub-hosted runner");
  expect(markup).toContain("2 min unmatched");
  expect(markup).toContain("Dated GitHub-hosted rates are applied by job completion date.");
});

test("renders the price-over-time chart above the breakdown", () => {
  const markup = renderToStaticMarkup(<CostCenterPriceChart points={points} />);
  expect(markup).toContain("Estimated GitHub-hosted retail cost avoided by completion date");
  expect(markup).toContain("<svg");
  expect(markup).toContain("2026-01-01");
});

test("formats platform, runner, and partial minute values", () => {
  expect(formatPlatform("macos-arm64")).toBe("macOS arm64");
  expect(formatPlatform("other")).toBe("other");
  expect(formatRunner(rows[1]!)).toBe("No comparable GitHub-hosted runner");
  expect(formatMinutesBreakdown(rows[1]!)).toBe("0 min priced · 2 min unmatched");
});

test("renders zero Cost Center summary and empty-state copy", () => {
  const zero = { ...savings, selfHostedMinutes: 0, pricedMinutes: 0, unpricedMinutes: 0, estimatedSavingsMicros: 0 };
  const markup = renderToStaticMarkup(<><Summary costSavings={zero} /><p className="cost-center-empty">No completed Mars jobs were recorded in this period.</p></>);
  expect(markup).toContain("$0.00");
  expect(markup).toContain("No completed Mars jobs were recorded in this period.");
});
