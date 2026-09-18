import type { CostCenterPricingProvider, OverviewDto } from "@mars/contracts";
import { formatMinutes } from "../format.ts";

export function GithubRunnerCostDisclosure({ costSavings, provider = "github" }: { costSavings: OverviewDto["costSavings"]; provider?: CostCenterPricingProvider }) {
  const name = provider === "blacksmith" ? "Blacksmith" : provider === "azure-vm" ? "Azure VM" : "GitHub-hosted";
  const latestRate = costSavings.latestRateEffectiveFrom ? ` Latest applied rate: ${new Date(`${costSavings.latestRateEffectiveFrom}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}.` : "";
  const partial = costSavings.unpricedMinutes > 0 ? ` ${formatMinutes(costSavings.unpricedMinutes)} could not be matched to a comparable ${name} runner, so the estimate is partial.` : "";
  return <p className="overview-cost-note">Dated {name} rates are applied by job completion date. Retail estimate excludes included plan minutes, public-repository free usage, and self-hosted infrastructure costs. Each completed Mars job is rounded independently.{partial}{latestRate}</p>;
}
