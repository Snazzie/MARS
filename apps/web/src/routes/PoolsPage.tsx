import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PoolSummary, WorkerDetail } from "@whitesmith/contracts";
import { getGlobalPools, getWorkers, mutateGlobalPool } from "../api.ts";
import { Disclosure } from "../components/Disclosure.tsx";
import { QueryState } from "../components/StateView.tsx";
import { workerOperationalLabel, workerReadinessLabel } from "../components/WorkerCard.tsx";

type PoolWorker = Pick<WorkerDetail, "id" | "platform" | "driver" | "connectionState" | "configurationState" | "draining">;
type PoolIdentity = Pick<PoolSummary, "platform" | "driver" | "workerId">;
export type PoolWorkerCoverage = { online: number; ready: number; warning: string | null; operational: string | null; readiness: string | null };
export function poolWorkerCoverage(pool: PoolIdentity, workers: PoolWorker[] | undefined): PoolWorkerCoverage {
  if (!workers) return { online: 0, ready: 0, warning: "Worker status unavailable", operational: null, readiness: null };
  const matching = pool.workerId ? workers.filter((worker) => worker.id === pool.workerId) : workers.filter((worker) => worker.platform === pool.platform && worker.driver === pool.driver);
  if (pool.workerId) {
    const worker = matching[0];
    if (!worker) return { online: 0, ready: 0, warning: "Worker status unavailable", operational: null, readiness: null };
    const online = worker.connectionState === "online" ? 1 : 0;
    const ready = online === 1 && worker.configurationState === "ready" && !worker.draining ? 1 : 0;
    return { online, ready, warning: ready === 0 ? "No ready workers" : null, operational: workerOperationalLabel(worker), readiness: workerReadinessLabel(worker.configurationState) };
  }
  const online = matching.filter((worker) => worker.connectionState === "online").length;
  const ready = matching.filter((worker) => worker.connectionState === "online" && worker.configurationState === "ready" && !worker.draining).length;
  return { online, ready, warning: ready === 0 ? "No ready workers" : null, operational: null, readiness: null };
}

function bytes(value: number) { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`; if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MiB`; return `${value} B`; }

export function PoolsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["pools", "global"], queryFn: getGlobalPools });
  const workers = useQuery({ queryKey: ["workers", "global", false], queryFn: () => getWorkers("all", false) });
  const action = useMutation({ mutationFn: ({ poolId, enabled }: { poolId: string; enabled: boolean }) => mutateGlobalPool(poolId, enabled ? "enable" : "disable"), onSuccess: () => client.invalidateQueries({ queryKey: ["pools", "global"] }) });
  return <><header className="page-header"><div><p className="eyebrow">Runner pools</p><h1>Shape capacity with intent.</h1><p className="page-description">Shared control-plane capacity across every connected workspace.</p></div></header><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} operationLabel="runner pools" />{query.data && <section className="pool-grid" aria-label="Runner pools">{query.data.items.map((pool: PoolSummary) => { const coverage = poolWorkerCoverage(pool, workers.data?.items); return <article className="pool-card" key={pool.id}><header className="panel-heading"><div><h2>{pool.name}</h2><p className="muted">{pool.workerName ?? "Shared fleet"} · {pool.platform} / {pool.driver}</p></div><span className={`status ${pool.enabled ? "status-approved" : "status-unavailable"}`}>{pool.enabled ? "Enabled" : "Disabled"}</span></header><dl className="pool-meta"><div><dt>Worker coverage</dt><dd>{coverage.ready}/{coverage.online} ready/online</dd></div><div><dt>Capacity</dt><dd>{pool.resources.concurrency} concurrent</dd></div><div><dt>Resources</dt><dd>{pool.resources.vcpu} vCPU · {bytes(pool.resources.memoryBytes)} RAM · {bytes(pool.resources.storageBytes)} disk</dd></div></dl>{coverage.warning && <p className="form-error">{coverage.warning}</p>}<Disclosure label="Advanced"><p className="muted">Labels: {pool.labels.join(", ")}</p><p className="muted">Image: <code>{pool.imageDigest}</code></p></Disclosure><button className="control-button" type="button" onClick={() => action.mutate({ poolId: pool.id, enabled: !pool.enabled })}>{pool.enabled ? "Disable pool" : "Enable pool"}</button></article>; })}</section>}</>;
}
