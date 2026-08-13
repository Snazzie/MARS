import { useMemo, useState, type FormEvent } from "react";
import type { WorkerCapacityData, WorkerLimits } from "@whitesmith/contracts";
import { configurePendingWorker, type WorkerConfigurationInput } from "../api.ts";

type Props = { worker: { id: string; capacity: WorkerCapacityData; limits: WorkerLimits | null }; onConfigured(): void };
const GIB = 1024 ** 3;
const initialGiB = (bytes: number) => {
  const value = Math.floor(bytes / GIB);
  return value > 0 ? String(value) : "";
};
const parsePositiveInteger = (value: string) => {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const toBytes = (value: string) => {
  const gib = parsePositiveInteger(value);
  if (gib === null || gib > Math.floor(Number.MAX_SAFE_INTEGER / GIB)) return null;
  const bytes = gib * GIB;
  return Number.isSafeInteger(bytes) ? bytes : null;
};

export function WorkerConfigurationForm({ worker, onConfigured }: Props) {
  const c = worker.capacity;
  const [vcpu, setVcpu] = useState(String(c.freeVcpu));
  const [ram, setRam] = useState(initialGiB(c.freeMemoryBytes));
  const [disk, setDisk] = useState(initialGiB(c.freeStorageBytes));
  const [maxVcpu, setMaxVcpu] = useState(() => String(Math.max(1, Math.floor(c.freeVcpu / 2))));
  const [maxRam, setMaxRam] = useState(() => initialGiB(Math.floor(c.freeMemoryBytes / 2)));
  const [maxDisk, setMaxDisk] = useState(() => initialGiB(Math.floor(c.freeStorageBytes / 2)));
  const [concurrency, setConcurrency] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const capacityError = useMemo(() => {
    if (c.freeMemoryBytes < GIB || c.freeStorageBytes < GIB) return "This worker reports less than 1 GiB of free RAM or disk; increase its capacity before configuring it.";
    return null;
  }, [c.freeMemoryBytes, c.freeStorageBytes]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const applianceVcpu = parsePositiveInteger(vcpu);
    const applianceMemory = toBytes(ram);
    const applianceStorage = toBytes(disk);
    const podVcpu = parsePositiveInteger(maxVcpu);
    const podMemory = toBytes(maxRam);
    const podStorage = toBytes(maxDisk);
    const maxConcurrentPods = parsePositiveInteger(concurrency);
    if (!applianceVcpu || !applianceMemory || !applianceStorage || !podVcpu || !podMemory || !podStorage || !maxConcurrentPods) return setError("All resource values must be positive whole numbers.");
    if (applianceVcpu > c.freeVcpu || applianceMemory > c.freeMemoryBytes || applianceStorage > c.freeStorageBytes) return setError("Appliance resources cannot exceed the worker's reported free capacity.");
    if (podVcpu > applianceVcpu || podMemory > applianceMemory || podStorage > applianceStorage) return setError("Per-job ceilings cannot exceed appliance resources.");
    if (podVcpu * maxConcurrentPods > applianceVcpu || podMemory * maxConcurrentPods > applianceMemory || podStorage * maxConcurrentPods > applianceStorage) return setError("Per-job ceilings multiplied by concurrency cannot exceed appliance resources.");
    const input: WorkerConfigurationInput = { appliance: { vcpu: applianceVcpu, memoryBytes: applianceMemory, storageBytes: applianceStorage }, runtime: { maxVcpuPerPod: podVcpu, maxMemoryBytesPerPod: podMemory, maxStorageBytesPerPod: podStorage, maxConcurrentPods } };
    setError(null);
    setPending(true);
    void configurePendingWorker(worker.id, input).then(onConfigured).catch((reason) => setError(reason instanceof Error ? reason.message : "Worker configuration failed.")).finally(() => setPending(false));
  };
  return <form className="worker-configuration-form" onSubmit={submit}><header className="worker-configuration-header"><div><p className="eyebrow">Approval and capacity</p><h3>Approve and configure worker</h3><p>Review the worker's reported capacity, then apply the limits it may use. Approval and configuration happen together.</p></div><span className="worker-status-badge">Pending approval</span></header>{capacityError && <p role="alert" className="form-error">{capacityError}</p>}{error && <p role="alert" className="form-error">{error}</p>}<fieldset><legend>Worker capacity</legend><p className="field-help">Reported free capacity: {c.freeVcpu} vCPU · {initialGiB(c.freeMemoryBytes)} GiB RAM · {initialGiB(c.freeStorageBytes)} GiB disk</p><div className="limit-grid"><label>vCPU<input name="vcpu" type="number" min="1" max={c.freeVcpu} step="1" value={vcpu} onChange={(e) => setVcpu(e.target.value)} required /><small>Maximum appliance allocation</small></label><label>RAM (GiB)<input name="memoryGiB" type="number" min="1" max={initialGiB(c.freeMemoryBytes)} step="1" value={ram} onChange={(e) => setRam(e.target.value)} required /><small>Maximum appliance allocation</small></label><label>Disk (GiB)<input name="storageGiB" type="number" min="1" max={initialGiB(c.freeStorageBytes)} step="1" value={disk} onChange={(e) => setDisk(e.target.value)} required /><small>Maximum appliance allocation</small></label></div></fieldset><fieldset><legend>Per-job limits</legend><p className="field-help">Each job is isolated. Limits are multiplied by concurrency and must fit within the worker capacity above.</p><div className="limit-grid"><label>Max vCPU per job<input name="maxVcpuPerPod" type="number" min="1" step="1" value={maxVcpu} onChange={(e) => setMaxVcpu(e.target.value)} required /></label><label>Max RAM per job (GiB)<input name="maxMemoryGiBPerPod" type="number" min="1" step="1" value={maxRam} onChange={(e) => setMaxRam(e.target.value)} required /></label><label>Max disk per job (GiB)<input name="maxStorageGiBPerPod" type="number" min="1" step="1" value={maxDisk} onChange={(e) => setMaxDisk(e.target.value)} required /></label><label>Max concurrent jobs<input name="maxConcurrentPods" type="number" min="1" step="1" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} required /></label></div></fieldset><div className="worker-configuration-actions"><button className="control-button" type="submit" disabled={pending || Boolean(capacityError)}>{pending ? "Approving and configuring…" : "Approve and configure worker"}</button></div></form>;
}
