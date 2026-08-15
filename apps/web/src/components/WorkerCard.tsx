import { useRef, useState } from "react";
import type { WorkerDetail } from "@whitesmith/contracts";
import { Button } from "@astryxdesign/core/Button";
import { WorkerActions } from "./WorkerActions.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";
import { WorkerDoctor } from "./WorkerDoctor.tsx";
function bytes(value: number): string { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`; if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MiB`; return `${value} B`; }
function capacity(label: string, value: { actual: number; reserved: number; free: number }, formatter: (n: number) => string = String) { return <div className="capacity-item"><span>{label}</span><strong>{formatter(value.free)} free</strong><small>{formatter(value.reserved)} reserved · {formatter(value.actual)} actual</small></div>; }
export function workerOperationalLabel(worker: Pick<WorkerDetail, "connectionState" | "draining">): "Online" | "Offline" | "Draining" { return worker.draining ? "Draining" : worker.connectionState === "online" ? "Online" : "Offline"; }
export function workerReadinessLabel(state: WorkerDetail["configurationState"]): "Ready" | "Needs configuration" | "Error" { return state === "ready" ? "Ready" : state === "error" ? "Error" : "Needs configuration"; }
export function WorkerCard({ worker, organizationId, onChange }: { worker: WorkerDetail; organizationId: string; onChange: () => void }) {
  const active = worker.admissionState === "adopted";
  const [configuring, setConfiguring] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const openConfiguration = () => { setConfiguring(true); dialog.current?.showModal(); };
  const closeConfiguration = () => { dialog.current?.close(); setConfiguring(false); };
  const capacityData = {
    actualVcpu: worker.capacity.vcpu.actual, actualMemoryBytes: worker.capacity.memoryBytes.actual, actualStorageBytes: worker.capacity.storageBytes.actual,
    freeVcpu: worker.capacity.vcpu.free, freeMemoryBytes: worker.capacity.memoryBytes.free, freeStorageBytes: worker.capacity.storageBytes.free,
  };
  return <article className={`worker-card ${worker.admissionState !== "adopted" ? "worker-card-pending" : ""}`} aria-labelledby={`worker-${worker.id}`}>
    <header className="worker-card-header"><div><div className="worker-name-row"><span className={`status-dot status-${worker.connectionState}`} aria-label={worker.connectionState} /><h2 id={`worker-${worker.id}`}>{worker.name}</h2></div><p className="worker-meta">{worker.platform} · guests: {worker.guestPlatforms.join(", ")} · {worker.driver} · <span className={`status-pill status-${worker.admissionState}`}>{worker.admissionState}</span></p><div className="worker-statuses" aria-label="Worker status"><span className={`status-pill status-${worker.connectionState}`}>{worker.connectionState}</span>{worker.draining && <span className="status-pill status-draining">draining</span>}{worker.configurationState !== "ready" && <span className={`status-pill status-${worker.configurationState}`}>{worker.configurationState}</span>}</div></div><WorkerActions organizationId={organizationId} workerId={worker.id} admissionState={worker.admissionState} draining={worker.draining} onComplete={onChange} />{active && <Button label="Configure" variant="secondary" clickAction={openConfiguration} />}</header>
    {worker.admissionState === "pending" && <p className="pending-note">Registered with the control plane. Configure resources before creating a pool.</p>}
    {worker.admissionState === "adopted" && worker.configurationState === "unconfigured" && <p className="pending-note">Configuration sent; waiting for worker acknowledgement.</p>}
    <div className="fingerprint-block"><span>Public key fingerprint</span><code tabIndex={0}>{worker.fingerprint}</code></div>
    <div className="worker-grid"><section className="worker-section"><div className="panel-kicker">Capacity / actual · reserved · free</div><div className="capacity-grid">{capacity("vCPU", worker.capacity.vcpu)}{capacity("Memory", worker.capacity.memoryBytes, bytes)}{capacity("Storage", worker.capacity.storageBytes, bytes)}{capacity("Pods", worker.capacity.pods)}</div></section><section className="worker-section"><div className="panel-kicker">Policy ceilings</div>{worker.limits ? <dl className="limits-list"><div><dt>vCPU / pod</dt><dd>{worker.limits.maxVcpuPerPod}</dd></div><div><dt>Memory / pod</dt><dd>{bytes(worker.limits.maxMemoryBytesPerPod)}</dd></div><div><dt>Storage / pod</dt><dd>{bytes(worker.limits.maxStorageBytesPerPod)}</dd></div><div><dt>Concurrency</dt><dd>{worker.limits.maxConcurrentPods}</dd></div></dl> : <p className="pending-note">No runtime limits configured.</p>}</section></div>
    {active && <WorkerDoctor doctor={worker.doctor} platform={worker.platform} />}
    <dialog ref={dialog} className="worker-config-dialog" onCancel={closeConfiguration} aria-label="Configure worker">{configuring && <WorkerConfigurationForm worker={{ id: worker.id, admissionState: worker.admissionState, platform: worker.platform, guestPlatforms: worker.guestPlatforms, draining: worker.draining, activeSandboxes: worker.activeSandboxes, capacity: capacityData, limits: worker.limits }} organizationId={organizationId} onConfigured={() => { closeConfiguration(); onChange(); }} />}</dialog>
  </article>;
}
