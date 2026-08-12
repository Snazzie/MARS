import { useState, type FormEvent } from "react";
import type { WorkerCapacityData, WorkerLimits } from "@whitesmith/contracts";
import { configurePendingWorker, type WorkerConfigurationInput } from "../api.ts";

type Props = { worker: { id: string; capacity: WorkerCapacityData; limits: WorkerLimits | null }; organizationId: string; onConfigured(): void };
const toBytes = (value: string) => Math.round(Number(value) * 1024 ** 3);
export function WorkerConfigurationForm({ worker, organizationId, onConfigured }: Props) {
  const c = worker.capacity;
  const [ram, setRam] = useState(String(Math.floor(c.freeMemoryBytes / 1024 ** 3)));
  const [disk, setDisk] = useState(String(Math.floor(c.freeStorageBytes / 1024 ** 3)));
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => { event.preventDefault(); const memoryBytes = toBytes(ram); const storageBytes = toBytes(disk); const vcpu = c.freeVcpu; const input: WorkerConfigurationInput = { organizationId, appliance: { vcpu, memoryBytes, storageBytes }, runtime: { maxVcpuPerPod: Math.max(1, Math.floor(vcpu / 2)), maxMemoryBytesPerPod: Math.max(1, Math.floor(memoryBytes / 2)), maxStorageBytesPerPod: Math.max(1, Math.floor(storageBytes / 2)), maxConcurrentPods: 1 } }; if (!Number.isSafeInteger(memoryBytes) || !Number.isSafeInteger(storageBytes) || memoryBytes <= 0 || storageBytes <= 0) { setError("Resource values must be positive whole GiB values."); return; } setError(null); void configurePendingWorker(worker.id, input).then(onConfigured).catch((e: unknown) => setError(e instanceof Error ? e.message : "Configuration failed")); };
  return <form className="worker-configuration-form" onSubmit={submit}><p>Configure worker resources and per-job ceilings.</p><p>Configure worker</p>{error && <p role="alert" className="form-error">{error}</p>}<label>vCPU<input name="vcpu" type="number" min="1" step="1" value={c.freeVcpu} readOnly /></label><label>RAM (GiB)<input name="memoryGiB" type="number" min="1" step="1" value={ram} onChange={(e) => setRam(e.target.value)} required /></label><label>Disk (GiB)<input name="storageGiB" type="number" min="1" step="1" value={disk} onChange={(e) => setDisk(e.target.value)} required /></label><label>Max concurrent pods<input name="maxConcurrentPods" type="number" min="1" step="1" value="1" readOnly /></label><button type="submit">Adopt and configure</button></form>;
}
