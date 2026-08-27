import { useMemo, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import type { WorkerCapacityData, WorkerLimits } from "@mars/contracts";
import { configurePendingWorker, configureWorker, rejectPendingWorker, type WorkerConfigurationInput } from "../api.ts";
type Props = { worker: { id: string; admissionState: "pending" | "adopted" | "rejected" | "revoked"; platform?: "linux-x64" | "windows-x64" | "macos-arm64"; guestPlatforms?: ("linux-x64" | "windows-x64" | "macos-arm64")[]; draining?: boolean; activeSandboxes?: number; capacity: WorkerCapacityData; limits: WorkerLimits | null; desiredCacheTtlSeconds?: number }; organizationId?: string; onConfigured(): void; onDiscard?(): void };
const GIB = 1024 ** 3;
const initialGiB = (bytes: number) => { const value = Math.floor(bytes / GIB); return value > 0 ? String(value) : ""; };
const parsePositiveInteger = (value: string) => { if (!/^\d+$/.test(value)) return null; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null; };
const toBytes = (value: string) => { const gib = parsePositiveInteger(value); if (gib === null || gib > Math.floor(Number.MAX_SAFE_INTEGER / GIB)) return null; const bytes = gib * GIB; return Number.isSafeInteger(bytes) ? bytes : null; };
export function WorkerConfigurationForm({ worker, organizationId, onConfigured, onDiscard }: Props) {
  const adopted = worker.admissionState === "adopted";
  const c = worker.capacity;
  const discard = useMutation({ mutationFn: rejectPendingWorker, onSuccess: () => onDiscard?.(), onError: (reason) => setError(reason instanceof Error ? reason.message : "Could not discard the pending worker.") });
  const platform = worker.platform ?? "linux-x64";
  const canEditGuests = !organizationId || (worker.draining === true && worker.activeSandboxes === 0);
  const [allowLinux, setAllowLinux] = useState(() => worker.guestPlatforms?.includes("linux-x64") ?? false);
  const [vcpu, setVcpu] = useState(String(c.freeVcpu));
  const [ram, setRam] = useState(initialGiB(c.freeMemoryBytes));
  const [disk, setDisk] = useState(initialGiB(c.freeStorageBytes));
  const [maxVcpu, setMaxVcpu] = useState(() => adopted && worker.limits ? String(worker.limits.maxVcpuPerPod) : String(Math.max(1, Math.floor(c.freeVcpu / 2))));
  const [maxRam, setMaxRam] = useState(() => adopted && worker.limits ? initialGiB(worker.limits.maxMemoryBytesPerPod) : initialGiB(Math.floor(c.freeMemoryBytes / 2)));
  const [maxDisk, setMaxDisk] = useState(() => adopted && worker.limits ? initialGiB(worker.limits.maxStorageBytesPerPod) : initialGiB(Math.floor(c.freeStorageBytes / 2)));
  const [concurrency, setConcurrency] = useState(() => adopted && worker.limits ? String(worker.limits.maxConcurrentPods) : "1");
  const [cacheTtlHours, setCacheTtlHours] = useState(() => {
    const seconds = worker.desiredCacheTtlSeconds ?? 48 * 60 * 60;
    return Number.isSafeInteger(seconds) && seconds > 0 && seconds % (60 * 60) === 0 ? String(seconds / (60 * 60)) : "48";
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const capacityError = useMemo(() => c.freeMemoryBytes < GIB || c.freeStorageBytes < GIB ? "This worker reports less than 1 GiB of free RAM or disk; increase its capacity before configuring it." : null, [c.freeMemoryBytes, c.freeStorageBytes]);
  const capabilityHelp = platform === "windows-x64" ? <div><label className="checkbox-field"><input type="checkbox" name="allowLinux" checked={allowLinux} disabled={!canEditGuests || pending} onChange={(event) => setAllowLinux(event.target.checked)} /> Allow Linux VMs</label>{organizationId && !canEditGuests && <p className="field-help">Drain this worker and wait for active jobs to finish before changing guest operating systems.</p>}</div> : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const applianceVcpu = parsePositiveInteger(vcpu);
    const applianceMemory = toBytes(ram);
    const applianceStorage = toBytes(disk);
    const podVcpu = parsePositiveInteger(maxVcpu);
    const podMemory = toBytes(maxRam);
    const podStorage = toBytes(maxDisk);
    const maxConcurrentPods = parsePositiveInteger(concurrency);
    const ttlHours = parsePositiveInteger(cacheTtlHours);
    if (!applianceVcpu || !applianceMemory || !applianceStorage || !podVcpu || !podMemory || !podStorage || !maxConcurrentPods || !ttlHours) return setError("All resource values and Cache TTL must be positive whole numbers.");
    if (ttlHours > Math.floor(Number.MAX_SAFE_INTEGER / (60 * 60))) return setError("Cache TTL is too large.");
    const ttlSeconds = ttlHours * 60 * 60;
    if (!Number.isSafeInteger(ttlSeconds)) return setError("Cache TTL is too large.");
    if (applianceVcpu > c.freeVcpu || applianceMemory > c.freeMemoryBytes || applianceStorage > c.freeStorageBytes) return setError("Appliance resources cannot exceed the worker's reported free capacity.");
    if (podVcpu > applianceVcpu || podMemory > applianceMemory || podStorage > applianceStorage) return setError("Per-job ceilings cannot exceed appliance resources.");
    const guestPlatforms: WorkerConfigurationInput["guestPlatforms"] = platform === "windows-x64" ? (allowLinux ? ["windows-x64", "linux-x64"] : ["windows-x64"]) : [platform];
    const input: WorkerConfigurationInput = {
      appliance: { vcpu: applianceVcpu, memoryBytes: applianceMemory, storageBytes: applianceStorage },
      runtime: { maxVcpuPerPod: podVcpu, maxMemoryBytesPerPod: podMemory, maxStorageBytesPerPod: podStorage, maxConcurrentPods },
      guestPlatforms,
      cache: { ttlSeconds },
    };
    setError(null);
    setPending(true);
    void (organizationId ? configureWorker(worker.id, input) : configurePendingWorker(worker.id, input)).then(onConfigured).catch((reason) => setError(reason instanceof Error ? reason.message : "Worker configuration failed.")).finally(() => setPending(false));
  };
  return <>
    {!adopted && <div className="worker-configuration-actions"><button type="button" className="control-button" onClick={() => { if (window.confirm("Discard this pending worker and generate a new installation?")) discard.mutate(worker.id); }} disabled={discard.isPending}>Discard and reinstall</button></div>}
    <form className="worker-configuration-form" onSubmit={submit}>
      <header className="worker-configuration-header"><div><p className="eyebrow">{adopted ? "Worker configuration" : "Approval and capacity"}</p><h3>{adopted ? "Configure worker" : "Approve and configure worker"}</h3><p>Review the worker's reported capacity, then apply the limits it may use.</p></div><span className="worker-status-badge">{adopted ? "Configured worker" : "Pending approval"}</span></header>
      {capacityError && <p role="alert" className="form-error">{capacityError}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {capabilityHelp}
      <fieldset><legend>Worker capacity</legend><p className="field-help">Reported free capacity: {c.freeVcpu} vCPU · {initialGiB(c.freeMemoryBytes)} GiB RAM · {initialGiB(c.freeStorageBytes)} GiB disk</p><div className="limit-grid"><label>vCPU<input name="vcpu" type="number" min="1" max={c.freeVcpu} step="1" value={vcpu} onChange={(e) => setVcpu(e.target.value)} required /><small>Maximum appliance allocation</small></label><label>RAM (GiB)<input name="memoryGiB" type="number" min="1" max={initialGiB(c.freeMemoryBytes)} step="1" value={ram} onChange={(e) => setRam(e.target.value)} required /><small>Maximum appliance allocation</small></label><label>Disk (GiB)<input name="storageGiB" type="number" min="1" max={initialGiB(c.freeStorageBytes)} step="1" value={disk} onChange={(e) => setDisk(e.target.value)} required /><small>Maximum appliance allocation</small></label></div></fieldset>
      <fieldset><legend>Per-job limits</legend><p className="field-help">Each job is isolated. These are independent per-job ceilings; the scheduler admits jobs dynamically as resources become available.</p><div className="limit-grid"><label>Max vCPU per job<input name="maxVcpuPerPod" type="number" min="1" step="1" value={maxVcpu} onChange={(e) => setMaxVcpu(e.target.value)} required /></label><label>Max RAM per job (GiB)<input name="maxMemoryGiBPerPod" type="number" min="1" step="1" value={maxRam} onChange={(e) => setMaxRam(e.target.value)} required /></label><label>Max disk per job (GiB)<input name="maxStorageGiBPerPod" type="number" min="1" step="1" value={maxDisk} onChange={(e) => setMaxDisk(e.target.value)} required /></label></div></fieldset>
      <fieldset><legend>Worker scheduling</legend><p className="field-help">Maximum jobs that may run concurrently. Jobs are admitted dynamically as worker resources become available.</p><label>Max concurrent jobs<input name="maxConcurrentPods" type="number" min="1" step="1" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} required /></label></fieldset>
      <fieldset><legend>Action cache</legend><p className="field-help">Cache entries expire after this many hours. This setting applies to the worker's local cache.</p><label>Cache TTL (hours)<input name="cacheTtlHours" type="number" min="1" step="1" value={cacheTtlHours} onChange={(e) => setCacheTtlHours(e.target.value)} required /></label></fieldset>
      <div className="worker-configuration-actions"><button className="control-button" type="submit" disabled={pending || Boolean(capacityError)}>{pending ? (adopted ? "Saving…" : "Approving and configuring…") : (adopted ? "Save configuration" : "Approve and configure worker")}</button></div>
    </form>
  </>;
}
