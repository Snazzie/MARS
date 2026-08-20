import { useRef, useState, type ReactNode } from "react";
import type { WorkerDetail } from "@whitesmith/contracts";
import { Button } from "@astryxdesign/core/Button";
import { WorkerActions } from "./WorkerActions.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";
import { WorkerDoctor } from "./WorkerDoctor.tsx";
import { WorkerImageBuildForm } from "./WorkerImageBuildForm.tsx";
function bytes(value: number): string { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`; if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MiB`; return `${value} B`; }
function capacity(label: string, value: { actual: number; reserved: number; free: number }, formatter: (n: number) => string = String) { return <div className="capacity-item"><span>{label}</span><strong>{formatter(value.free)} free</strong><small>{formatter(value.reserved)} reserved · {formatter(value.actual)} actual</small></div>; }
export function workerOperationalLabel(worker: Pick<WorkerDetail, "connectionState" | "draining">): "Online" | "Offline" | "Draining" { return worker.draining ? "Draining" : worker.connectionState === "online" ? "Online" : "Offline"; }
export function workerReadinessLabel(state: WorkerDetail["configurationState"]): "Ready" | "Applying configuration" | "Needs configuration" | "Error" { return state === "ready" ? "Ready" : state === "applying" ? "Applying configuration" : state === "error" ? "Error" : "Needs configuration"; }
function appliedAt(value: string): string { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)); }
function telemetryAt(value: string | null): ReactNode {
  return value ? <time dateTime={value}>{appliedAt(value)}</time> : "Never";
}
export function WorkerCard({ worker, organizationId, onChange }: { worker: WorkerDetail; organizationId: string; onChange: () => void }) {
  const active = worker.admissionState === "adopted";
  const effectiveConfigurationState = worker.configurationState === "ready" && worker.configurationRevision !== worker.appliedConfigurationRevision ? "applying" : worker.configurationState;
  const runtimeReady = worker.doctor?.runtimeReady === true && worker.doctor.probe === true && worker.doctor.egress === true && worker.doctor.imageSignatures === true;
  const readinessLabel = workerReadinessLabel(effectiveConfigurationState);
  const applied = worker.appliedConfigurationRevision && worker.configurationAppliedAt
    ? { revision: worker.appliedConfigurationRevision.slice(0, 12), at: appliedAt(worker.configurationAppliedAt) }
    : null;
  const [configuring, setConfiguring] = useState(false);
  const [building, setBuilding] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const openConfiguration = () => { setConfiguring(true); dialog.current?.showModal(); };
  const closeConfiguration = () => { dialog.current?.close(); setConfiguring(false); };
  const capacityData = {
    actualVcpu: worker.capacity.vcpu.actual, actualMemoryBytes: worker.capacity.memoryBytes.actual, actualStorageBytes: worker.capacity.storageBytes.actual,
    freeVcpu: worker.capacity.vcpu.free, freeMemoryBytes: worker.capacity.memoryBytes.free, freeStorageBytes: worker.capacity.storageBytes.free,
  };
  return <article className={`worker-card ${worker.admissionState !== "adopted" ? "worker-card-pending" : ""}`} aria-labelledby={`worker-${worker.id}`}>
    <header className="worker-card-header"><div><div className="worker-name-row"><span className={`status-dot status-${worker.connectionState}`} aria-label={worker.connectionState} /><h2 id={`worker-${worker.id}`}>{worker.name}</h2></div><p className="worker-meta">{worker.platform} · guests: {worker.guestPlatforms.join(", ")} · {worker.driver} · <span className={`status-pill status-${worker.admissionState}`}>{worker.admissionState}</span></p><div className="worker-statuses" aria-label="Worker status"><span className={`status-pill status-${worker.connectionState}`}>{worker.connectionState}</span>{worker.draining && <span className="status-pill status-draining">draining</span>}<span className={`status-pill status-${effectiveConfigurationState}`}>{readinessLabel}</span></div></div><WorkerActions organizationId={organizationId} workerId={worker.id} admissionState={worker.admissionState} draining={worker.draining} activeSandboxes={worker.activeSandboxes} platform={worker.platform} runtimeMode={worker.platform === "windows-x64" ? "container" : worker.runtimeMode === "container" || worker.runtimeMode === "vm" ? worker.runtimeMode : null} onComplete={onChange} />{active && <Button label="Configure" variant="secondary" clickAction={openConfiguration} />}</header>
    {active && worker.platform === "windows-x64" && <button type="button" className="control-button" onClick={() => setBuilding(true)} disabled={worker.connectionState !== "online" || worker.doctor?.runtimeBuildState === "building"} title={worker.connectionState === "online" ? "Send the declarative image build to the worker" : "Worker must be online before it can build an image"}>{worker.connectionState !== "online" ? "Worker offline" : worker.doctor?.runtimeBuildState === "building" ? "Building…" : "Build local image"}</button>}
    {worker.admissionState === "pending" && <p className="pending-note">Registered with the control plane. Configure resources before creating a pool.</p>}
    {active && effectiveConfigurationState === "ready" && applied && <p className="pending-note">Configuration updated <time dateTime={worker.configurationAppliedAt!}>{applied.at}</time> · revision <code>{applied.revision}</code></p>}
    {active && effectiveConfigurationState === "ready" && worker.doctor?.runtimeBuildState === "building" && <p className="pending-note" role="status">Building local runtime image. Scheduling remains paused until the worker reports completion.</p>}
    {active && effectiveConfigurationState === "ready" && !runtimeReady && worker.doctor?.runtimeBuildState !== "building" && <p className="pending-note" role="status">Runtime image is not ready. Scheduling remains paused until the worker reports a verified local runtime.</p>}
    {active && effectiveConfigurationState === "error" && <p className="pending-note" role="alert">Configuration update failed.{applied ? <> Last applied <time dateTime={worker.configurationAppliedAt!}>{applied.at}</time> · revision <code>{applied.revision}</code>.</> : " No configuration has been acknowledged."}</p>}
    <div className="fingerprint-block"><span>Public key fingerprint</span><code tabIndex={0}>{worker.fingerprint}</code></div>
    <dl className="limits-list worker-telemetry">
      <div><dt>Last heartbeat</dt><dd>{telemetryAt(worker.lastHeartbeatAt)}</dd></div>
      <div><dt>Last successful doctor</dt><dd>{telemetryAt(worker.lastDoctorAt)}</dd></div>
      <div><dt>Runtime mode</dt><dd>{worker.runtimeMode ?? "Not reported"}</dd></div>
      <div><dt>Artifact digest</dt><dd>{worker.artifactDigest ? <code>{worker.artifactDigest}</code> : worker.doctor?.artifactIdentity ? <code>{worker.doctor.artifactIdentity}</code> : "Not reported"}</dd></div>
      <div><dt>Active leases</dt><dd>{worker.activeSandboxes}</dd></div>
    </dl>
    <div className="worker-grid"><section className="worker-section"><div className="panel-kicker">Capacity / actual · reserved · free</div><div className="capacity-grid">{capacity("vCPU", worker.capacity.vcpu)}{capacity("Memory", worker.capacity.memoryBytes, bytes)}{capacity("Storage", worker.capacity.storageBytes, bytes)}{capacity("Pods", worker.capacity.pods)}</div></section><section className="worker-section"><div className="panel-kicker">Policy ceilings</div>{worker.limits ? <dl className="limits-list"><div><dt>vCPU / pod</dt><dd>{worker.limits.maxVcpuPerPod}</dd></div><div><dt>Memory / pod</dt><dd>{bytes(worker.limits.maxMemoryBytesPerPod)}</dd></div><div><dt>Storage / pod</dt><dd>{bytes(worker.limits.maxStorageBytesPerPod)}</dd></div><div><dt>Concurrency</dt><dd>{worker.limits.maxConcurrentPods}</dd></div></dl> : <p className="muted">Not configured.</p>}</section></div>
    {building && <dialog open className="worker-config-dialog" aria-label="Build local runtime image"><WorkerImageBuildForm organizationId={organizationId} workerId={worker.id} onComplete={() => { setBuilding(false); onChange(); }} onCancel={() => setBuilding(false)} /></dialog>}
    {active && <WorkerDoctor doctor={worker.doctor} platform={worker.platform} dispatchReady={effectiveConfigurationState === "ready" && runtimeReady} />}
    <dialog ref={dialog} className="worker-config-dialog" onCancel={closeConfiguration} aria-label="Configure worker">{configuring && <WorkerConfigurationForm worker={{ id: worker.id, admissionState: worker.admissionState, platform: worker.platform, guestPlatforms: worker.guestPlatforms, draining: worker.draining, activeSandboxes: worker.activeSandboxes, capacity: capacityData, limits: worker.limits }} organizationId={organizationId} onConfigured={() => { closeConfiguration(); onChange(); }} />}</dialog>
  </article>;
}
