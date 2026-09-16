import type { OverviewDto } from "@mars/contracts";
import { formatMinutes } from "../format.ts";

export function GithubRunnerCostDisclosure({ costSavings }: { costSavings: OverviewDto["costSavings"] }) {
  const latestRate = costSavings.latestRateEffectiveFrom ? ` Latest applied rate: ${new Date(`${costSavings.latestRateEffectiveFrom}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}.` : "";
  const partial = costSavings.unpricedMinutes > 0 ? ` ${formatMinutes(costSavings.unpricedMinutes)} could not be matched to a comparable GitHub-hosted runner, so the estimate is partial.` : "";
  return <p className="overview-cost-note">Dated GitHub-hosted rates are applied by job completion date. Retail estimate excludes included plan minutes, public-repository free usage, and self-hosted infrastructure costs. Each completed Mars job is rounded independently.{partial}{latestRate}</p>;
}
