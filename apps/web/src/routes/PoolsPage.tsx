import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PoolSummary } from "@whitesmith/contracts";
import { getPools, mutatePool } from "../api.ts";
import { QueryState, WorkspaceRequired } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

function bytes(value: number) { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`; if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MiB`; return `${value} B`; }

export function PoolsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["org", organizationId, "pools"], queryFn: () => getPools(organizationId), enabled: organizationId !== "all" });
  const action = useMutation({ mutationFn: ({ poolId, type, workspaceId }: { poolId: string; type: "enable" | "disable" | "rotate-key"; workspaceId: string }) => mutatePool(workspaceId, poolId, type), onSuccess: () => client.invalidateQueries({ queryKey: ["org", organizationId, "pools"] }) });
  if (organizationId === "all") return <WorkspaceRequired />;
  return <><header className="page-header"><div><p className="eyebrow">Runner pools</p><h1>Shape capacity with intent.</h1><p className="page-description">Labels route jobs; ceilings keep every sandbox inside its worker budget.</p></div></header><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} />{query.data && <section className="pool-grid" aria-label="Runner pools">{query.data.items.map((pool: PoolSummary) => <article className="pool-card" key={pool.id}><header className="panel-heading"><div><h2>{pool.name}</h2><p className="muted">{pool.workerName} · {pool.platform} · {pool.driver}</p></div><span className={`status-pill ${pool.enabled ? "status-online" : "status-offline"}`}>{pool.enabled ? "Enabled" : "Disabled"}</span></header><dl><div><dt>Storage</dt><dd>{bytes(pool.resources.storageBytes)}</dd></div><div><dt>Concurrency</dt><dd>{pool.resources.concurrency}</dd></div></dl><p className="muted">Labels: {pool.labels.join(", ")}</p><div className="card-actions"><button type="button" onClick={() => action.mutate({ poolId: pool.id, workspaceId: organizationId, type: pool.enabled ? "disable" : "enable" })}>{pool.enabled ? "Disable pool" : "Enable pool"}</button></div></article>)}</section>}</>;
}
