import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { runtimeDriverForPlatform, type RuntimePlatform, type RuntimeDriverName, type WorkerCapacityData, type WorkerLimits, type WorkerRuntimeCapability } from "@mars/contracts";
import { configurePendingWorker, configureWorker, rejectPendingWorker, type WorkerConfigurationInput } from "../api.ts";
type Props = { worker: { id: string; admissionState: "pending" | "adopted" | "rejected" | "revoked"; platform?: RuntimePlatform; guestPlatforms?: RuntimePlatform[]; selectedDriver?: RuntimeDriverName | null; capabilities?: WorkerRuntimeCapability[]; draining?: boolean; activeSandboxes?: number; capacity: WorkerCapacityData; limits: WorkerLimits | null; desiredCacheTtlSeconds?: number; desiredRunnerCacheEnabled?: boolean; desiredRunnerCacheMaxGiB?: number }; organizationId?: string; onConfigured(): void; onDiscard?(): void };
const runtimeDriverForHost = (platform: RuntimePlatform): RuntimeDriverName => runtimeDriverForPlatform(platform);
const GIB = 1024 ** 3;
const initialGiB = (bytes: number) => { const value = Math.floor(bytes / GIB); return value > 0 ? String(value) : ""; };
const parsePositiveInteger = (value: string) => { if (!/^\d+$/.test(value)) return null; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null; };
const toBytes = (value: string) => { const gib = parsePositiveInteger(value); if (gib === null || gib > Math.floor(Number.MAX_SAFE_INTEGER / GIB)) return null; const bytes = gib * GIB; return Number.isSafeInteger(bytes) ? bytes : null; };
export function WorkerConfigurationForm({ worker, organizationId, onConfigured, onDiscard }: Props) {
  const adopted = worker.admissionState === "adopted";
  const c = worker.capacity;
  const discard = useMutation({ mutationFn: rejectPendingWorker, onSuccess: () => onDiscard?.(), onError: (reason) => setError(reason instanceof Error ? reason.message : "Could not discard the pending worker.") });
  const platform = worker.platform ?? "linux-x64";
  const canEditGuests = !organizationId || (worker.selectedDriver == null && worker.activeSandboxes === 0) || (worker.draining === true && worker.activeSandboxes === 0);
  const [allowLinux, setAllowLinux] = useState(() => worker.guestPlatforms?.includes(platform === "macos-arm64" ? "linux-arm64" : "linux-x64") || (platform === "macos-arm64" && !adopted));
  const [selectedGuestPlatform, setSelectedGuestPlatform] = useState<"linux-x64" | "linux-arm64" | "windows-x64" | null>(() => {
    const guest = worker.selectedDriver ? worker.capabilities?.find((item) => item.driver === worker.selectedDriver && item.ready)?.guestPlatform : undefined;
    return guest === "linux-x64" || guest === "linux-arm64" || guest === "windows-x64" ? guest : null;
  });
  const [selectedDriver, setSelectedDriver] = useState<RuntimeDriverName | "">(() => worker.selectedDriver && worker.capabilities?.some((item) => item.driver === worker.selectedDriver) ? worker.selectedDriver : "");
  const [vcpu, setVcpu] = useState(String(c.actualVcpu));
  const [ram, setRam] = useState(initialGiB(c.actualMemoryBytes));
  const [disk, setDisk] = useState(initialGiB(c.actualStorageBytes));
  const [maxVcpu, setMaxVcpu] = useState(() => adopted && worker.limits ? String(worker.limits.maxVcpuPerPod) : String(Math.max(1, Math.floor(c.actualVcpu / 2))));
  const [maxRam, setMaxRam] = useState(() => adopted && worker.limits ? initialGiB(worker.limits.maxMemoryBytesPerPod) : initialGiB(Math.floor(c.actualMemoryBytes / 2)));
  const [maxDisk, setMaxDisk] = useState(() => adopted && worker.limits ? initialGiB(worker.limits.maxStorageBytesPerPod) : initialGiB(Math.floor(c.actualStorageBytes / 2)));
  const [concurrency, setConcurrency] = useState(() => adopted && worker.limits ? String(worker.limits.maxConcurrentPods) : "1");
  const [cacheTtlHours, setCacheTtlHours] = useState(() => {
    const seconds = worker.desiredCacheTtlSeconds ?? 48 * 60 * 60;
    return Number.isSafeInteger(seconds) && seconds > 0 && seconds % (60 * 60) === 0 ? String(seconds / (60 * 60)) : "48";
  });
  const [runnerCacheEnabled, setRunnerCacheEnabled] = useState(() => worker.desiredRunnerCacheEnabled ?? true);
  const [runnerCacheMaxGiB, setRunnerCacheMaxGiB] = useState(() => String(worker.desiredRunnerCacheMaxGiB ?? 20));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const windowsOptions: { driver: RuntimeDriverName; guestPlatform: "linux-x64" | "linux-arm64" | "windows-x64"; label: string }[] = [
    { driver: "linux-docker-container", guestPlatform: "linux-x64", label: "Docker Linux container" },
    { driver: "linux-docker-container", guestPlatform: "linux-arm64", label: "Docker Linux container (ARM64)" },
    { driver: "windows-process-container", guestPlatform: "windows-x64", label: "Docker Windows container (process isolation)" },
    { driver: "windows-hyperv-container", guestPlatform: "windows-x64", label: "Docker Windows container (Hyper-V isolation)" },
    { driver: "windows-hyperv", guestPlatform: "windows-x64", label: "Windows Hyper-V VM" },
  ];
  const selectedCapability = worker.capabilities?.find((item) => item.driver === selectedDriver && item.guestPlatform === selectedGuestPlatform && item.ready);
  const capabilityHelp = (platform === "windows-x64" || platform === "windows-arm64") ? <fieldset className="worker-runtime-fieldset">
    <legend>Runtime capability</legend>
    <p className="field-help">Choose an advertised, ready runtime.</p>
    <div className="worker-runtime-options">{windowsOptions.filter((option) => platform !== "windows-arm64" ? !(option.guestPlatform === "linux-x64" && worker.capabilities?.some((item) => item.driver === "linux-docker-container" && item.guestPlatform === "linux-arm64")) : option.guestPlatform === "linux-arm64").map((option) => {
      const capability = worker.capabilities?.find((item) => item.driver === option.driver && item.guestPlatform === option.guestPlatform);
      const note = !capability ? "Not advertised" : !capability.ready ? `Not ready${capability.remediation ? ` — ${capability.remediation}` : ""}` : option.driver === "windows-process-container" ? "Does not provide the Hyper-V host boundary" : capability.remediation;
      return <label className="worker-runtime-option" key={`${option.driver}:${option.guestPlatform}`}>
        <input type="radio" name="selectedDriver" value={`${option.driver}:${option.guestPlatform}`} checked={selectedDriver === option.driver && selectedGuestPlatform === option.guestPlatform} disabled={pending || !capability?.ready || (organizationId !== undefined && !canEditGuests)} onChange={() => { setSelectedDriver(option.driver); setSelectedGuestPlatform(option.guestPlatform); }} />
        <span><strong>{option.label}</strong>{note && <small>{note}</small>}</span>
      </label>;
    })}</div>
  </fieldset> : null;
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
    const maxGiB = parsePositiveInteger(runnerCacheMaxGiB);
    if (!applianceVcpu || !applianceMemory || !applianceStorage || !podVcpu || !podMemory || !podStorage || !maxConcurrentPods || !ttlHours || !maxGiB) return setError("All resource values, Cache TTL, and runner cache size must be positive whole numbers.");
    if ((platform === "windows-x64" || platform === "windows-arm64") && (!selectedDriver || !selectedCapability)) return setError("Select an advertised, ready runtime capability.");
    if (ttlHours > Math.floor(Number.MAX_SAFE_INTEGER / (60 * 60))) return setError("Cache TTL is too large.");
    if (maxGiB > Number.MAX_SAFE_INTEGER) return setError("Runner cache size is too large.");
    const ttlSeconds = ttlHours * 60 * 60;
    if (!Number.isSafeInteger(ttlSeconds)) return setError("Cache TTL is too large.");
    if (applianceVcpu > c.actualVcpu || applianceMemory > c.actualMemoryBytes || applianceStorage > c.actualStorageBytes) return setError("Appliance resources cannot exceed the worker's total capacity.");
    if (podVcpu > applianceVcpu || podMemory > applianceMemory || podStorage > applianceStorage) return setError("Per-job ceilings cannot exceed appliance resources.");
    const guestPlatforms: WorkerConfigurationInput["guestPlatforms"] = platform === "windows-x64" || platform === "windows-arm64" ? [selectedCapability!.guestPlatform] : platform === "macos-arm64" ? (allowLinux ? ["macos-arm64", "linux-arm64"] : ["macos-arm64"]) : [platform];
    const input: WorkerConfigurationInput = {
      appliance: { vcpu: applianceVcpu, memoryBytes: applianceMemory, storageBytes: applianceStorage },
      runtime: { maxVcpuPerPod: podVcpu, maxMemoryBytesPerPod: podMemory, maxStorageBytesPerPod: podStorage, maxConcurrentPods },
      guestPlatforms,
      selectedDriver: platform === "windows-x64" || platform === "windows-arm64" ? selectedCapability!.driver : runtimeDriverForHost(platform),
      cache: { ttlSeconds, runnerCacheEnabled, runnerCacheMaxGiB: maxGiB },
    };
    setError(null);
    setPending(true);
    void (organizationId ? configureWorker(worker.id, input) : configurePendingWorker(worker.id, input)).then(onConfigured).catch((reason) => setError(reason instanceof Error ? reason.message : "Worker configuration failed.")).finally(() => setPending(false));
  };
  return <>
    <form className="worker-configuration-form" onSubmit={submit}>
      <header className="worker-configuration-header"><h3>{adopted ? "Configure worker" : "Set worker limits"}</h3></header>
      {error && <p role="alert" className="form-error">{error}</p>}
      {capabilityHelp}
      <fieldset><legend>Worker capacity</legend><p className="field-help">Free now: {c.freeVcpu} vCPU · {initialGiB(c.freeMemoryBytes)} GiB RAM · {initialGiB(c.freeStorageBytes)} GiB disk</p><div className="limit-grid worker-capacity-grid"><label>vCPU<input name="vcpu" type="number" min="1" max={c.actualVcpu} step="1" value={vcpu} onChange={(e) => setVcpu(e.target.value)} required /></label><label>RAM (GiB)<input name="memoryGiB" type="number" min="1" max={initialGiB(c.actualMemoryBytes)} step="1" value={ram} onChange={(e) => setRam(e.target.value)} required /></label><label>Disk (GiB)<input name="storageGiB" type="number" min="1" max={initialGiB(c.actualStorageBytes)} step="1" value={disk} onChange={(e) => setDisk(e.target.value)} required /></label></div></fieldset>
      <fieldset><legend>Job limits</legend><div className="limit-grid"><label>vCPU per job<input name="maxVcpuPerPod" type="number" min="1" step="1" value={maxVcpu} onChange={(e) => setMaxVcpu(e.target.value)} required /></label><label>RAM per job (GiB)<input name="maxMemoryGiBPerPod" type="number" min="1" step="1" value={maxRam} onChange={(e) => setMaxRam(e.target.value)} required /></label><label>Disk per job (GiB)<input name="maxStorageGiBPerPod" type="number" min="1" step="1" value={maxDisk} onChange={(e) => setMaxDisk(e.target.value)} required /></label><label>Concurrent jobs<input name="maxConcurrentPods" type="number" min="1" step="1" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} required /></label></div></fieldset>
      <details className="worker-configuration-advanced"><summary>Action cache settings</summary><fieldset><legend>Action cache</legend><p className="field-help">Cache entries expire after this many hours. This setting applies to the worker's local cache.</p><label>Cache TTL (hours)<input name="cacheTtlHours" type="number" min="1" step="1" value={cacheTtlHours} onChange={(e) => setCacheTtlHours(e.target.value)} /></label><label>Cache size (GiB)<input name="runnerCacheMaxGiB" type="number" min="1" step="1" value={runnerCacheMaxGiB} onChange={(e) => setRunnerCacheMaxGiB(e.target.value)} /></label><label className="checkbox-field"><input name="runnerCacheEnabled" type="checkbox" checked={runnerCacheEnabled} disabled={pending} onChange={(event) => setRunnerCacheEnabled(event.target.checked)} /> Enable worker cache service</label><p className="field-help">Local runner caching uses up to the configured size on this worker.</p></fieldset></details>
      <div className="worker-configuration-actions">{!adopted && <button type="button" className="control-button destructive" onClick={() => { if (window.confirm("Reject this pending worker? It will need to enroll again.")) discard.mutate(worker.id); }} disabled={pending || discard.isPending}>Reject worker</button>}<button className="control-button" type="submit" disabled={pending || discard.isPending}>{pending ? (adopted ? "Saving…" : "Approving…") : (adopted ? "Save configuration" : "Approve and configure worker")}</button></div>
    </form>
  </>;
}
