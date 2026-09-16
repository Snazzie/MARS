import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CostCenterBreakdown, DashboardPeriod, CostCenterDto } from "@mars/contracts";
import { getCostCenter } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { ReportingPeriodControl, reportingPeriodLabels } from "../components/ReportingPeriodControl.tsx";
import { GithubRunnerCostDisclosure } from "../components/GithubRunnerCostDisclosure.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
import { formatMinutes, formatUsdMicros } from "../format.ts";

export const costCenterQueryOptions = (organizationId: string, period: DashboardPeriod) => ({ queryKey: ["org", organizationId, "cost-center", period], queryFn: () => getCostCenter(organizationId, period), enabled: Boolean(organizationId), ...(organizationId === "all" ? { refetchInterval: 5_000 } : {}) });
export const formatPlatform = (platform: string) => ({ "linux-x64": "Linux x64", "windows-x64": "Windows x64", "macos-arm64": "macOS arm64" } as Record<string, string>)[platform] ?? platform;
export const formatRunner = (row: CostCenterBreakdown) => row.githubRunnerSku && row.githubRunnerVcpu ? `${row.githubRunnerSku} · ${row.githubRunnerVcpu} vCPU` : "No comparable GitHub-hosted runner";
export const formatMinutesBreakdown = (row: CostCenterBreakdown) => row.unpricedMinutes > 0 ? `${formatMinutes(row.pricedMinutes)} priced · ${formatMinutes(row.unpricedMinutes)} unmatched` : formatMinutes(row.selfHostedMinutes);

function PageHeader({ period, onPeriodChange }: { period: DashboardPeriod; onPeriodChange: (period: DashboardPeriod) => void }) {
  return <header className="page-header cost-center-header"><div><p className="eyebrow">Cost Center / {reportingPeriodLabels[period]}</p><h1>Where the estimate comes from.</h1><p className="page-description">Completed Mars jobs matched to equivalent GitHub-hosted runner retail rates.</p></div><ReportingPeriodControl value={period} onChange={onPeriodChange} label="Cost Center time window" /></header>;
}
export function Summary({ costSavings }: { costSavings: CostCenterDto["costSavings"] }) {
  return <section className="cost-center-summary" aria-label="Cost Center summary"><div className="metric"><span>Estimated GitHub-hosted retail cost avoided</span><strong>{formatUsdMicros(costSavings.estimatedSavingsMicros)}</strong><small>avoided retail compute estimate</small></div><div className="metric"><span>Self-hosted billable-equivalent minutes</span><strong>{formatMinutes(costSavings.selfHostedMinutes)}</strong><small>all completed Mars jobs</small></div><div className="metric"><span>Priced minutes</span><strong>{formatMinutes(costSavings.pricedMinutes)}</strong><small>matched to a dated runner rate</small></div></section>;
}
export function BreakdownTable({ rows }: { rows: CostCenterBreakdown[] }) {
  return <div className="cost-center-table-wrap"><table className="cost-center-table"><caption className="sr-only">Cost Center repository and comparable GitHub runner breakdown</caption><thead><tr><th scope="col">Repository</th><th scope="col">Mars request</th><th scope="col">Comparable GitHub runner</th><th scope="col">Jobs</th><th scope="col">Billable minutes</th><th scope="col">Estimated savings</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.organizationId}-${row.repositoryId}-${row.platform}-${row.requestedVcpu}-${row.githubRunnerSku ?? "unmatched"}`}><th scope="row">{row.repositoryName}</th><td>{formatPlatform(row.platform)} · {row.requestedVcpu} vCPU</td><td>{formatRunner(row)}</td><td>{row.jobCount.toLocaleString("en-US")}</td><td>{formatMinutesBreakdown(row)}</td><td>{formatUsdMicros(row.estimatedSavingsMicros)}</td></tr>)}</tbody></table></div>;
}
export function CostCenterPage() {
  const { organizationId } = useOrganizationFromRoute();
  const search = useSearch({ from: "/_authenticated/cost-center" });
  const navigate = useNavigate({ from: "/_authenticated/cost-center" });
  const period = search.period as DashboardPeriod;
  const query = useQuery(costCenterQueryOptions(organizationId, period));
  const setPeriod = (next: DashboardPeriod) => void navigate({ search: { period: next }, replace: true });
  return <><PageHeader period={period} onPeriodChange={setPeriod} /><QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="Cost Center" />{query.data && <><Summary costSavings={query.data.costSavings} /><GithubRunnerCostDisclosure costSavings={query.data.costSavings} />{query.data.breakdown.length > 0 ? <BreakdownTable rows={query.data.breakdown} /> : <p className="cost-center-empty">No completed Mars jobs were recorded in this period.</p>}</>}</>;
}
