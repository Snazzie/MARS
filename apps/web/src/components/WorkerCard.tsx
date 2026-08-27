import { useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { DashboardWorkerCacheEntry, WorkerDetail } from "@mars/contracts";
import { getWorkerCache, setWorkerLeasePreservation } from "../api.ts";
import { Button } from "@astryxdesign/core/Button";
import { WorkerActions } from "./WorkerActions.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";
import { WorkerDoctor } from "./WorkerDoctor.tsx";
import { WorkerHealthPanel } from "./WorkerHealthPanel.tsx";
import { useWorkerHealth } from "./useWorkerHealth.ts";
import { WorkerImageBuildForm } from "./WorkerImageBuildForm.tsx";
function formatScaledBytes(bytes: bigint, unit: bigint, label: string): string {
  const tenths = (bytes * 10n + unit / 2n) / unit;
  return `${tenths / 10n}.${tenths % 10n} ${label}`;
}
function formatBytes(value: string | null | undefined): string {
  if (value == null) return "Not reported";
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return `${value} B`;
  const bytes = BigInt(value);
  const mib = 1024n ** 2n;
  const gib = 1024n ** 3n;
  const tib = 1024n ** 4n;
  if (bytes >= tib) return formatScaledBytes(bytes, tib, "TiB");
  if (bytes >= gib) return formatScaledBytes(bytes, gib, "GiB");
  if (bytes >= mib) return `${(bytes + mib / 2n) / mib} MiB`;
  return `${bytes} B`;
}
export function workerOperationalLabel(worker: Pick<WorkerDetail, "connectionState" | "draining">): "Online" | "Offline" | "Draining" { return worker.draining ? "Draining" : worker.connectionState === "online" ? "Online" : "Offline"; }
export function workerReadinessLabel(state: WorkerDetail["configurationState"]): "Ready" | "Applying configuration" | "Needs configuration" | "Error" { return state === "ready" ? "Ready" : state === "applying" ? "Applying configuration" : state === "error" ? "Error" : "Needs configuration"; }
function appliedAt(value: string): string { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)); }
function telemetryAt(value: string | null): ReactNode {
  return value ? <time dateTime={value}>{appliedAt(value)}</time> : "Never";
}
function cacheEntrySize(value: string): string { return formatBytes(value); }
function cacheInventory(workerId: string) {
  return <WorkerCacheInventory workerId={workerId} />;
}
function WorkerCacheInventory({ workerId }: { workerId: string }) {
  const [query, setQuery] = useState("");
  const inventory = useInfiniteQuery({
    queryKey: ["workers", workerId, "cache", query],
    queryFn: ({ pageParam }: { pageParam: string | null }) => getWorkerCache(workerId, { cursor: pageParam, query, limit: 25 }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const entries = inventory.data?.pages.flatMap((page) => page.items) ?? [];
  return <div className="worker-cache-inventory">
    <label>Search cache inventory<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Repository, key, scope, or hash" /></label>
    {inventory.isLoading && <p role="status">Loading cache inventory…</p>}
    {inventory.error && <p role="alert">Cache inventory unavailable. {inventory.error instanceof Error ? inventory.error.message : "Try again later."}</p>}
    {!inventory.isLoading && !inventory.error && entries.length === 0 && <p className="pending-note">No cache entries match this search.</p>}
    {entries.length > 0 && <div className="worker-cache-table-wrap"><table><caption>Read-only worker cache inventory</caption><thead><tr><th>Repository</th><th>Key preview</th><th>Scope preview</th><th>Version</th><th>Size</th><th>Last hit</th><th>Expires</th></tr></thead><tbody>{entries.map((entry: DashboardWorkerCacheEntry) => <tr key={entry.entryId}><td>{entry.repositoryUrl ? <a href={entry.repositoryUrl}>{entry.repositoryFullName ?? entry.githubRepositoryId}</a> : <span>{entry.repositoryFullName ?? entry.githubRepositoryId}</span>}<small>Repository metadata · ID {entry.githubRepositoryId}</small></td><td><code>{entry.cacheKeyPreview}</code><small>Workflow-provided metadata</small></td><td><code>{entry.scopePreview}</code><small>Workflow-provided metadata</small></td><td><code>{entry.versionHash}</code></td><td>{cacheEntrySize(entry.sizeBytes)}</td><td><time dateTime={entry.lastAccessedAt}>{appliedAt(entry.lastAccessedAt)}</time></td><td><time dateTime={entry.expiresAt}>{appliedAt(entry.expiresAt)}</time></td></tr>)}</tbody></table></div>}
    {inventory.hasNextPage && <button type="button" className="control-button" onClick={() => void inventory.fetchNextPage()} disabled={inventory.isFetchingNextPage}>{inventory.isFetchingNextPage ? "Loading…" : "Load more"}</button>}
  </div>;
}
function WorkerHealthSection({ worker }: { worker: WorkerDetail }) {
  const healthQuery = useWorkerHealth(worker.id);
  return <WorkerHealthPanel workerId={worker.id} health={healthQuery.data} loading={healthQuery.isLoading} error={healthQuery.error} limits={worker.limits} showConnectionStatus={false} />;
}

export function WorkerCard({ worker, organizationId, onChange, canManage = false }: { worker: WorkerDetail; organizationId: string; onChange: () => void; canManage?: boolean }) {
  const active = worker.admissionState === "adopted";
  const [preservationPending, setPreservationPending] = useState(false);
  const [preservationError, setPreservationError] = useState<string | null>(null);
  const togglePreservation = async (enabled: boolean) => {
    setPreservationPending(true);
    setPreservationError(null);
    try { await setWorkerLeasePreservation(organizationId, worker.id, enabled); onChange(); }
    catch (cause) { setPreservationError(cause instanceof Error ? cause.message : "Preservation setting failed"); }
    finally { setPreservationPending(false); }
  };
  const effectiveConfigurationState = worker.configurationState === "ready" && worker.configurationRevision !== worker.appliedConfigurationRevision ? "applying" : worker.configurationState;
  const runtimeReady = worker.doctor?.runtimeReady === true && worker.doctor.probe === true && worker.doctor.egress === true && worker.doctor.imageSignatures === true;
  const cache = worker.cache;
  const [cacheInventoryOpen, setCacheInventoryOpen] = useState(false);
  const readinessLabel = workerReadinessLabel(effectiveConfigurationState);
  const applied = worker.appliedConfigurationRevision && worker.configurationAppliedAt
    ? { revision: worker.appliedConfigurationRevision.slice(0, 12), at: appliedAt(worker.configurationAppliedAt) }
    : null;
  const [configuring, setConfiguring] = useState(false);
  const [building, setBuilding] = useState(false);
  const staleBefore = Date.now() - 300_000;
  const dialog = useRef<HTMLDialogElement>(null);
  const openConfiguration = () => { setConfiguring(true); dialog.current?.showModal(); };
  const closeConfiguration = () => { dialog.current?.close(); setConfiguring(false); };
  const capacityData = {
    actualVcpu: worker.capacity.vcpu.actual, actualMemoryBytes: worker.capacity.memoryBytes.actual, actualStorageBytes: worker.capacity.storageBytes.actual,
    freeVcpu: worker.capacity.vcpu.free, freeMemoryBytes: worker.capacity.memoryBytes.free, freeStorageBytes: worker.capacity.storageBytes.free,
  };
  return <article className={`worker-card ${worker.admissionState !== "adopted" ? "worker-card-pending" : ""}`} aria-labelledby={`worker-${worker.id}`}>
    <header className="worker-card-header">
      <div className="worker-card-identity">
        <div className="worker-name-row"><span className={`status-dot status-${worker.connectionState}`} aria-label={worker.connectionState} /><h2 id={`worker-${worker.id}`}>{worker.name}</h2></div>
        <div className="worker-statuses" aria-label="Worker status"><span className={`status-pill status-${worker.connectionState}`}>{worker.connectionState}</span>{worker.lastHeartbeatAt && Date.parse(worker.lastHeartbeatAt) < staleBefore && <span className="status-pill status-stale">stale heartbeat</span>}{worker.lastDoctorAt && Date.parse(worker.lastDoctorAt) < staleBefore && <span className="status-pill status-stale">stale doctor</span>}{worker.draining && <span className="status-pill status-draining">draining</span>}<span className={`status-pill status-${effectiveConfigurationState}`}>{readinessLabel}</span><span className={`status-pill status-${worker.admissionState}`}>{worker.admissionState}</span></div>
        <p className="worker-meta">{worker.platform} · guests: {worker.guestPlatforms.join(", ")} · {worker.driver} · <span className="worker-fingerprint">key <code tabIndex={0} title={worker.fingerprint}>{worker.fingerprint}</code></span></p>
      </div>
      <div className="worker-card-controls">
        {active && worker.platform === "windows-x64" && <button type="button" className="control-button" onClick={() => setBuilding(true)} disabled={worker.connectionState !== "online" || worker.doctor?.runtimeBuildState === "building"} title={worker.connectionState === "online" ? "Send the declarative image build to the worker" : "Worker must be online before it can build an image"}>{worker.connectionState !== "online" ? "Worker offline" : worker.doctor?.runtimeBuildState === "building" ? "Building…" : "Build local image"}</button>}
        <WorkerActions organizationId={organizationId} workerId={worker.id} admissionState={worker.admissionState} draining={worker.draining} activeSandboxes={worker.activeSandboxes} platform={worker.platform} runtimeMode={worker.platform === "windows-x64" ? "container" : worker.runtimeMode === "container" || worker.runtimeMode === "vm" ? worker.runtimeMode : null} onComplete={onChange} />
        {active && <Button label="Configure" variant="secondary" clickAction={openConfiguration} />}
      </div>
    </header>
    {active && canManage && <div className="worker-policy-control"><label title="Keeps failed runtimes for inspection and consumes worker capacity until disabled."><input type="checkbox" checked={worker.preserveLeases === true} disabled={preservationPending} onChange={(event) => { void togglePreservation(event.currentTarget.checked); }} /> Preserve failed containers</label>{preservationError && <p className="form-error" role="alert">{preservationError}</p>}</div>}
    <dl className="limits-list worker-telemetry worker-operational-strip">
      <div><dt>Last heartbeat</dt><dd>{telemetryAt(worker.lastHeartbeatAt)}</dd></div>
      <div><dt>Last successful doctor</dt><dd>{telemetryAt(worker.lastDoctorAt)}</dd></div>
      <div><dt>Runtime mode</dt><dd>{worker.runtimeMode ?? "Not reported"}</dd></div>
      <div><dt>Active leases</dt><dd>{worker.activeSandboxes}</dd></div>
    </dl>
    {active && effectiveConfigurationState === "ready" && applied && <p className="pending-note">Configuration updated <time dateTime={worker.configurationAppliedAt!}>{applied.at}</time> · revision <code>{applied.revision}</code></p>}
    {worker.admissionState === "pending" && <p className="pending-note">Registered with the control plane. Configure resources before creating a pool.</p>}
    {active && effectiveConfigurationState === "ready" && worker.doctor?.runtimeBuildState === "building" && <p className="pending-note" role="status">Building local runtime image. Scheduling remains paused until the worker reports completion.</p>}
    {active && effectiveConfigurationState === "ready" && !runtimeReady && worker.doctor?.runtimeBuildState !== "building" && <p className="pending-note" role="status">Runtime image is not ready. Scheduling remains paused until the worker reports a verified local runtime.</p>}
    {active && effectiveConfigurationState === "error" && <p className="pending-note" role="alert">Configuration update failed.{applied ? <> Last applied <time dateTime={worker.configurationAppliedAt!}>{applied.at}</time> · revision <code>{applied.revision}</code>.</> : " No configuration has been acknowledged."}</p>}
    <WorkerHealthSection worker={worker} />
    {active && <section className="worker-section worker-cache-panel" aria-label="Cache inventory"><div className="panel-kicker">Cache inventory</div>{cache?.ready && cache.entryCount > 0 ? <details onToggle={(event) => setCacheInventoryOpen(event.currentTarget.open)}><summary>Browse cache inventory</summary>{cacheInventoryOpen && cacheInventory(worker.id)}</details> : <p className="muted">{cache?.ready ? "No cache entries." : "Cache inventory unavailable."}</p>}</section>}
    {building && <dialog open className="worker-config-dialog" aria-label="Build local runtime image"><WorkerImageBuildForm organizationId={organizationId} workerId={worker.id} onComplete={() => { setBuilding(false); onChange(); }} onCancel={() => setBuilding(false)} /></dialog>}
    {active && <WorkerDoctor doctor={worker.doctor} platform={worker.platform} dispatchReady={effectiveConfigurationState === "ready" && runtimeReady} />}
    <dialog ref={dialog} className="worker-config-dialog" onCancel={closeConfiguration} aria-label="Configure worker">{configuring && <WorkerConfigurationForm worker={{ id: worker.id, admissionState: worker.admissionState, platform: worker.platform, guestPlatforms: worker.guestPlatforms, draining: worker.draining, activeSandboxes: worker.activeSandboxes, capacity: capacityData, limits: worker.limits, desiredCacheTtlSeconds: cache?.desiredTtlSeconds }} organizationId={organizationId} onConfigured={() => { closeConfiguration(); onChange(); }} />}</dialog>
  </article>;
}
