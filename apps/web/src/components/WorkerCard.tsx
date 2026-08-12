import type { WorkerDetail } from "@whitesmith/contracts";
import { WorkerActions } from "./WorkerActions.tsx";
import { WorkerDoctor } from "./WorkerDoctor.tsx";

function bytes(value: number): string { if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`; if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MiB`; return `${value} B`; }
function capacity(label: string, value: { actual: number; reserved: number; free: number }, formatter: (n: number) => string = String) { return <div className="capacity-item"><span>{label}</span><strong>{formatter(value.free)} free</strong><small>{formatter(value.reserved)} reserved · {formatter(value.actual)} actual</small></div>; }
export function WorkerCard({ worker, organizationId, onChange }: { worker: WorkerDetail; organizationId: string; onChange: () => void }) {
  const active = worker.admissionState === "adopted";
  return <article className={`worker-card ${worker.admissionState !== "adopted" ? "worker-card-pending" : ""}`} aria-labelledby={`worker-${worker.id}`}>
    <header className="worker-card-header"><div><div className="worker-name-row"><span className={`status-dot status-${worker.connectionState}`} aria-label={worker.connectionState} /><h2 id={`worker-${worker.id}`}>{worker.name}</h2></div><p className="worker-meta">{worker.platform} · {worker.driver} · <span className={`status-pill status-${worker.admissionState}`}>{worker.admissionState}</span></p></div><WorkerActions organizationId={organizationId} workerId={worker.id} admissionState={worker.admissionState} draining={worker.draining} onComplete={onChange} /></header>
    <div className="fingerprint-block"><span>Public key fingerprint</span><code tabIndex={0}>{worker.fingerprint}</code></div>
    {worker.admissionState === "pending" && <p className="pending-note">Pending adoption. Compare this fingerprint with the appliance terminal before adopting.</p>}
    <div className="worker-grid"><section className="worker-section"><div className="panel-kicker">Capacity / actual · reserved · free</div><div className="capacity-grid">{capacity("vCPU", worker.capacity.vcpu)}{capacity("Memory", worker.capacity.memoryBytes, bytes)}{capacity("Storage", worker.capacity.storageBytes, bytes)}{capacity("Pods", worker.capacity.pods)}</div></section><section className="worker-section"><div className="panel-kicker">Policy ceilings</div>{worker.limits ? <dl className="limits-list"><div><dt>vCPU / pod</dt><dd>{worker.limits.maxVcpuPerPod}</dd></div><div><dt>Memory / pod</dt><dd>{bytes(worker.limits.maxMemoryBytesPerPod)}</dd></div><div><dt>Storage / pod</dt><dd>{bytes(worker.limits.maxStorageBytesPerPod)}</dd></div><div><dt>Concurrent pods</dt><dd>{worker.limits.maxConcurrentPods}</dd></div></dl> : <p className="muted">Not configured. Adopt the worker, then save safe ceilings.</p>}<p className="lease-summary"><strong>{worker.activeSandboxes}</strong> active sandbox{worker.activeSandboxes === 1 ? "" : "es"} · {worker.draining ? "draining" : "accepting leases"}</p></section></div>
    {active && <WorkerDoctor doctor={worker.doctor} />}
  </article>;
}
