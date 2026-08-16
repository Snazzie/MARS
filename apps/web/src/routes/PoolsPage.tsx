import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreatePoolRequest, type PoolSummary, type WorkerDetail } from "@whitesmith/contracts";
import { ApiRequestError, deleteGlobalPool, getGlobalPools, getWorkers, mutateGlobalPool, saveGlobalPool } from "../api.ts";
import { Disclosure } from "../components/Disclosure.tsx";
import { QueryState } from "../components/StateView.tsx";
import { workerOperationalLabel, workerReadinessLabel } from "../components/WorkerCard.tsx";

type PoolWorker = Pick<WorkerDetail, "id" | "platform" | "driver" | "connectionState" | "configurationState" | "configurationRevision" | "appliedConfigurationRevision" | "draining"> & { guestPlatforms?: WorkerDetail["guestPlatforms"] };
type PoolIdentity = Pick<PoolSummary, "platform" | "driver" | "workerId">;
export type PoolWorkerCoverage = { online: number; ready: number; warning: string | null; operational: string | null; readiness: string | null };
export function poolWorkerCoverage(pool: PoolIdentity, workers: PoolWorker[] | undefined): PoolWorkerCoverage {
  if (!workers) return { online: 0, ready: 0, warning: "Worker status unavailable", operational: null, readiness: null };
  const matching = pool.workerId ? workers.filter((worker) => worker.id === pool.workerId) : workers.filter((worker) => (worker.guestPlatforms?.includes(pool.platform) ?? worker.platform === pool.platform) && worker.driver === pool.driver);
  const isReady = (worker: PoolWorker) => worker.connectionState === "online" && worker.configurationState === "ready" && worker.configurationRevision === worker.appliedConfigurationRevision && !worker.draining;
  if (pool.workerId) {
    const worker = matching[0];
    if (!worker) return { online: 0, ready: 0, warning: "Worker status unavailable", operational: null, readiness: null };
    const online = worker.connectionState === "online" ? 1 : 0;
    const ready = isReady(worker) ? 1 : 0;
    return { online, ready, warning: ready === 0 ? "No ready workers" : null, operational: workerOperationalLabel(worker), readiness: workerReadinessLabel(worker.configurationState) };
  }
  const online = matching.filter((worker) => worker.connectionState === "online").length;
  const ready = matching.filter(isReady).length;
  return { online, ready, warning: ready === 0 ? "No compatible ready worker" : null, operational: null, readiness: null };
}

function bytes(value: number) { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`; if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MiB`; return `${value} B`; }
const gib = (value: number) => Math.max(1, Math.round(value / 1024 ** 3));

function PoolEditor({ pool, workers, onCancel, onSave, pending, error }: { pool: PoolSummary | null; workers: WorkerDetail[]; onCancel: () => void; onSave: (value: CreatePoolRequest) => void; pending: boolean; error: string | null }) {
  const compatible = workers.filter((worker) => worker.platform !== "linux-x64" && worker.admissionState === "adopted" && worker.configurationState === "ready" && worker.configurationRevision === worker.appliedConfigurationRevision && !worker.draining);
  const initialWorker = compatible.find((worker) => worker.guestPlatforms.includes(pool?.platform ?? "windows-x64")) ?? compatible[0];
  const [workerId, setWorkerId] = useState(initialWorker?.id ?? "");
  const worker = compatible.find((candidate) => candidate.id === workerId);
  const [platform, setPlatform] = useState(pool?.platform ?? initialWorker?.guestPlatforms[0] ?? "windows-x64");
  const [name, setName] = useState(pool?.name ?? "");
  const [label, setLabel] = useState(pool?.triggerLabel ?? "");
  const [digest, setDigest] = useState(pool?.imageDigest ?? initialWorker?.artifactDigest ?? "");
  const [vcpu, setVcpu] = useState(pool?.resources.vcpu ?? 1);
  const [memoryGiB, setMemoryGiB] = useState(gib(pool?.resources.memoryBytes ?? 4 * 1024 ** 3));
  const [storageGiB, setStorageGiB] = useState(gib(pool?.resources.storageBytes ?? 20 * 1024 ** 3));
  const [concurrency, setConcurrency] = useState(pool?.resources.concurrency ?? 1);
  return <form className="pool-editor" onSubmit={(event) => {
    event.preventDefault();
    const parsed = CreatePoolRequest.safeParse({ poolId: pool?.id, workerId, name, guestPlatform: platform, triggerLabel: label, imageDigest: digest, resources: { vcpu, memoryBytes: memoryGiB * 1024 ** 3, storageBytes: storageGiB * 1024 ** 3, concurrency } });
    if (parsed.success) onSave(parsed.data);
  }}>
    <h2>{pool ? `Edit ${pool.name}` : "Create runner pool"}</h2>
    <p>New and edited pools remain disabled until a compatible worker is online and recently healthy.</p>
    <label>Reference worker<select value={workerId} required onChange={(event) => { const id = event.target.value; const selected = compatible.find((candidate) => candidate.id === id); setWorkerId(id); if (selected) { setPlatform(selected.guestPlatforms[0]); setDigest(selected.artifactDigest ?? ""); } }}>{compatible.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
    <label>Guest platform<select value={platform} onChange={(event) => setPlatform(event.target.value as typeof platform)}>{worker?.guestPlatforms.map((guest) => <option key={guest} value={guest}>{guest}</option>)}</select></label>
    <p>Runtime driver: <code>{worker?.driver ?? "Select a worker"}</code></p>
    <label>Pool name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>Canonical trigger label<input required pattern="[a-z0-9][a-z0-9._-]{0,62}" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
    <label>Immutable image or checkpoint digest<input required value={digest} pattern="(?:[^@\s]+@)?sha256:[0-9a-fA-F]{64}" onChange={(event) => setDigest(event.target.value)} /></label>
    <fieldset><legend>Lease resources</legend><label>vCPU<input type="number" min="1" value={vcpu} onChange={(event) => setVcpu(Number(event.target.value))} /></label><label>Memory (GiB)<input type="number" min="1" value={memoryGiB} onChange={(event) => setMemoryGiB(Number(event.target.value))} /></label><label>Storage (GiB)<input type="number" min="1" value={storageGiB} onChange={(event) => setStorageGiB(Number(event.target.value))} /></label><label>Concurrency<input type="number" min="1" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label></fieldset>
    {compatible.length === 0 && <p role="alert">No adopted worker has a fully reconciled configuration. Configure a worker before creating a pool.</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="dialog-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" disabled={pending || compatible.length === 0}>{pending ? "Saving…" : "Save disabled pool"}</button></div>
  </form>;
}

export function PoolsPage() {
  const client = useQueryClient();
  const [editing, setEditing] = useState<PoolSummary | "new" | null>(null);
  const [deleting, setDeleting] = useState<PoolSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useInfiniteQuery({ queryKey: ["pools", "global"], queryFn: ({ pageParam }: { pageParam: string | null }) => getGlobalPools(pageParam), initialPageParam: null, getNextPageParam: (page) => page.nextCursor ?? undefined });
  const workers = useQuery({ queryKey: ["workers", "global", false], queryFn: () => getWorkers("all", false) });
  const pools = query.data?.pages.flatMap((page) => page.items) ?? [];
  const refresh = () => void client.invalidateQueries({ queryKey: ["pools", "global"] });
  const save = useMutation({ mutationFn: saveGlobalPool, onSuccess: () => { setEditing(null); setError(null); refresh(); }, onError: (cause) => setError(cause instanceof ApiRequestError ? cause.message : "Pool could not be saved") });
  const action = useMutation({ mutationFn: ({ poolId, enabled }: { poolId: string; enabled: boolean }) => mutateGlobalPool(poolId, enabled ? "enable" : "disable"), onSuccess: () => { setError(null); refresh(); }, onError: (cause) => setError(cause instanceof ApiRequestError ? cause.message : "Pool action failed") });
  const remove = useMutation({ mutationFn: deleteGlobalPool, onSuccess: () => { setDeleting(null); setError(null); refresh(); }, onError: (cause) => setError(cause instanceof ApiRequestError ? cause.message : "Pool could not be deleted") });
  return <><header className="page-header"><div><p className="eyebrow">Runner pools</p><h1>Shape capacity with intent.</h1><p className="page-description">Shared control-plane capacity across every connected workspace.</p></div><button type="button" onClick={() => { setError(null); setEditing("new"); }}>Create pool</button></header>
    {error && !editing && <p role="alert" className="inline-error">{error}</p>}
    <QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && pools.length === 0} retry={() => void query.refetch()} operationLabel="runner pools" />
    {pools.length > 0 && <section className="pool-grid" aria-label="Runner pools">{pools.map((pool) => { const coverage = poolWorkerCoverage(pool, workers.data?.items); const mutable = !pool.enabled && pool.active === 0; return <article className="pool-card" key={pool.id}><header className="panel-heading"><div><h2>{pool.name}</h2><p className="muted">{pool.workerName ?? "Shared fleet"} · {pool.platform}</p></div><span className={`status-pill ${pool.enabled ? "status-good" : "status-neutral"}`}>{pool.enabled ? "Enabled" : "Disabled"}</span></header><dl className="pool-stats"><div><dt>Active leases</dt><dd>{pool.active}</dd></div><div><dt>Compatible workers</dt><dd>{coverage.ready} ready / {coverage.online} online</dd></div><div><dt>Concurrency</dt><dd>{pool.resources.concurrency}</dd></div></dl>{coverage.warning && <p className="inline-warning">{coverage.warning}</p>}<p className="form-row"><code>{pool.triggerLabel ?? pool.labels.join(", ")}</code></p><Disclosure label="Advanced"><p className="muted">Driver: {pool.driver}</p><p className="muted">Image: <code>{pool.imageDigest}</code></p><p className="muted">Resources: {pool.resources.vcpu} vCPU · {bytes(pool.resources.memoryBytes)} memory · {bytes(pool.resources.storageBytes)} storage</p></Disclosure><div className="pool-actions"><button className="button" type="button" onClick={() => action.mutate({ poolId: pool.id, enabled: !pool.enabled })} disabled={action.isPending || (!pool.enabled && coverage.ready === 0)}>{pool.enabled ? "Disable" : "Enable"}</button><button className="button button-secondary" type="button" disabled={!mutable} title={mutable ? undefined : "Disable the pool and wait for active leases to be reaped"} onClick={() => { setError(null); setEditing(pool); }}>Edit</button><button className="button button-secondary" type="button" disabled={!mutable} title={mutable ? undefined : "Disable the pool and wait for active leases to be reaped"} onClick={() => { setError(null); setDeleting(pool); }}>Delete</button></div></article>; })}</section>}
    {query.hasNextPage && <button type="button" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Loading…" : "Load more pools"}</button>}
    {editing && <dialog open className="pool-dialog" aria-label={editing === "new" ? "Create pool" : "Edit pool"}><PoolEditor key={editing === "new" ? "new" : editing.id} pool={editing === "new" ? null : editing} workers={workers.data?.items ?? []} pending={save.isPending} error={error} onCancel={() => setEditing(null)} onSave={(value) => save.mutate(value)} /></dialog>}
    {deleting && <dialog open className="confirm-dialog" aria-labelledby="delete-pool-title"><h2 id="delete-pool-title">Delete {deleting.name}?</h2><p>This permanently removes the disabled pool. Historical runs and logs remain.</p>{error && <p role="alert" className="inline-error">{error}</p>}<div className="dialog-actions"><button type="button" onClick={() => setDeleting(null)}>Cancel</button><button type="button" onClick={() => remove.mutate(deleting.id)} disabled={remove.isPending}>{remove.isPending ? "Deleting…" : "Delete pool"}</button></div></dialog>}
  </>;
}
