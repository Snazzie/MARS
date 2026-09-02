import type { ReactNode } from "react";
import type { WorkerDetail, WorkerHealth } from "@mars/contracts";

const STALE_AFTER_SECONDS = 300;

type WorkerHealthPanelProps = {
  workerId?: string;
  health?: WorkerHealth | null;
  loading?: boolean;
  error?: unknown;
  limits?: WorkerDetail["limits"];
  showConnectionStatus?: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Try again later.";
}

function formatScaledBytes(bytes: bigint, unit: bigint, label: string): string {
  const tenths = (bytes * 10n + unit / 2n) / unit;
  return `${tenths / 10n}.${tenths % 10n} ${label}`;
}

function formatBytes(value: string): string {
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
type UsageMetric = { actual: number | string; reserved: number | string; free: number | string };

function allocationPercent(reserved: number | string, available: number | string): number | null {
  const reservedText = String(reserved);
  const availableText = String(available);
  if (/^(?:0|[1-9]\d*)$/.test(reservedText) && /^(?:0|[1-9]\d*)$/.test(availableText)) {
    const reservedInteger = BigInt(reservedText);
    const availableInteger = BigInt(availableText);
    const total = reservedInteger + availableInteger;
    if (total === 0n) return null;
    return Number((reservedInteger * 10000n) / total) / 100;
  }
  const reservedNumber = typeof reserved === "number" ? reserved : Number(reserved);
  const availableNumber = typeof available === "number" ? available : Number(available);
  const total = reservedNumber + availableNumber;
  if (!Number.isFinite(reservedNumber) || !Number.isFinite(availableNumber) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (reservedNumber / total) * 100));
}


function formatTtl(seconds: number | null): string {
  return seconds == null ? "Not reported" : `${seconds / 3600} hours`;
}

function timestamp(value: string | null, fallback = "Unavailable telemetry"): ReactNode {
  if (!value) return fallback;
  return <time dateTime={value}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))}</time>;
}

function cacheStale(observedAt: string | null): boolean {
  if (!observedAt) return false;
  const ageSeconds = (Date.now() - Date.parse(observedAt)) / 1000;
  return ageSeconds > STALE_AFTER_SECONDS;
}

function age(value: number | null): string {
  return value == null ? "Unavailable telemetry" : `${value}s`;
}

function ageDisplay(value: number | null, startedAt: string | null): ReactNode {
  const label = age(value);
  return startedAt ? <time dateTime={startedAt}>{label}</time> : label;
}
function stale(value: number | null): boolean {
  return value != null && value > STALE_AFTER_SECONDS;
}

function StatusBadge({ children }: { children: ReactNode }) {
  return <span className="worker-health-status">{children}</span>;
}

function UsageSection({ health, idPrefix, limits }: { health: WorkerHealth; idPrefix: string; limits?: WorkerDetail["limits"] }) {
  const metrics: Array<{ label: string; values: UsageMetric; bytes?: boolean; ceiling: number | null }> = [
    { label: "CPU", values: health.usage.cpu, ceiling: limits?.maxVcpuPerPod ?? null },
    { label: "Memory", values: health.usage.memoryBytes, bytes: true, ceiling: limits?.maxMemoryBytesPerPod ?? null },
    { label: "Storage", values: health.usage.storageBytes, bytes: true, ceiling: limits?.maxStorageBytesPerPod ?? null },
    { label: "Pods", values: health.usage.pods, ceiling: limits?.maxConcurrentPods ?? null },
  ];
  return <section className="worker-health-section" aria-labelledby={`${idPrefix}-usage-heading`}>
    <h3 id={`${idPrefix}-usage-heading`}>System usage</h3>
    <div className="worker-health-usage-table-wrap">
      <table className="worker-health-usage-table">
        <caption>Worker resource capacity and allocation</caption>
        <thead><tr><th scope="col">Resource</th><th scope="col">Worker capacity</th><th scope="col">Reserved by workers</th><th scope="col">Available</th><th scope="col">Per-job ceiling</th><th scope="col">Allocation</th></tr></thead>
        <tbody>{metrics.map(({ label, values, bytes, ceiling }) => {
          const actual = bytes ? formatBytes(String(values.actual)) : String(values.actual);
          const reserved = bytes ? formatBytes(String(values.reserved)) : String(values.reserved);
          const available = bytes ? formatBytes(String(values.free)) : String(values.free);
          const allocation = allocationPercent(values.reserved, values.free);
          const reservedWidth = allocation ?? 0;
          const availableWidth = allocation == null ? 0 : 100 - reservedWidth;
          return <tr key={label}>
            <th scope="row">{label}</th>
            <td>{actual}</td>
            <td>{reserved}</td>
            <td>{available}</td>
            <td>{ceiling == null ? "Not configured" : bytes ? formatBytes(String(ceiling)) : ceiling}</td>
            <td>
              <div className="worker-health-usage-bar" role="img" aria-label={`${label}: ${reserved} reserved by workers, ${available} available`}>
                <span className="worker-health-usage-bar-reserved" style={{ width: `${reservedWidth}%` }} aria-hidden="true" />
                <span className="worker-health-usage-bar-available" style={{ width: `${availableWidth}%` }} aria-hidden="true" />
              </div>
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <ul className="worker-health-usage-legend" aria-label="Resource usage legend">
      <li><span className="worker-health-legend-swatch worker-health-legend-actual" aria-hidden="true" />Actual capacity</li>
      <li><span className="worker-health-legend-swatch worker-health-legend-reserved" aria-hidden="true" />Reserved by workers</li>
      <li><span className="worker-health-legend-swatch worker-health-legend-available" aria-hidden="true" />Available</li>
    </ul>
  </section>;
}

function CacheSection({ health, idPrefix }: { health: WorkerHealth; idPrefix: string }) {
  const cache = health.cache;
  return <section className="worker-health-section" aria-labelledby={`${idPrefix}-cache-heading`}>
    <h3 id={`${idPrefix}-cache-heading`}>Cache health</h3>
    <dl className="worker-health-details">
      <div><dt>Readiness</dt><dd>{cache.ready ? "Ready" : "Unavailable"}</dd></div>
      <div><dt>Desired TTL</dt><dd>{formatTtl(cache.desiredTtlSeconds)}</dd></div>
      <div><dt>Effective TTL</dt><dd>{formatTtl(cache.effectiveTtlSeconds)}</dd></div>
      <div><dt>Generation</dt><dd>{cache.generation ?? "No cache snapshot"}</dd></div>
      <div><dt>Actions entries</dt><dd>{cache.entryCount}</dd></div>
      <div><dt>Actions size</dt><dd>{formatBytes(cache.sizeBytes)}</dd></div>
      <div><dt>Runner cache enabled</dt><dd>{cache.effectiveRunnerCacheEnabled == null ? "Not reported" : cache.effectiveRunnerCacheEnabled ? "Enabled" : "Disabled"}</dd></div>
      <div><dt>Runner cache capacity</dt><dd>{cache.effectiveRunnerCacheMaxGiB == null ? "Not reported" : `${cache.effectiveRunnerCacheMaxGiB} GiB`}</dd></div>
      <div><dt>Runner cache entries</dt><dd>{cache.runnerCacheEntryCount}</dd></div>
      <div><dt>Runner cache size</dt><dd>{formatBytes(cache.runnerCacheSizeBytes)}</dd></div>
      <div><dt>Runner cache observed</dt><dd>{timestamp(cache.runnerCacheObservedAt)}</dd></div>
      <div><dt>Actions observed</dt><dd>{timestamp(cache.observedAt)}</dd></div>
      <div><dt>Proxy status</dt><dd>{cache.ready ? "Available" : "Unavailable"}</dd></div>
    </dl>
    <div className="worker-health-statuses" aria-label="Cache health status">
      {!cache.generation && <StatusBadge>No cache snapshot</StatusBadge>}
      {cacheStale(cache.observedAt) && <StatusBadge>Stale cache</StatusBadge>}
      {!cache.observedAt && <StatusBadge>Unavailable telemetry</StatusBadge>}
    </div>
    {cache.error && <div className="worker-health-error" role="alert"><strong>Cache error</strong><span>{cache.error}</span><small>Remediation: verify the worker cache service and retry the health check.</small></div>}
  </section>;
}

function JobCells({ job }: { job: WorkerHealth["jobs"][number] }) {
  return <>
    <td>{job.jobId ?? "Unavailable telemetry"}</td>
    <td>{job.repositoryFullName ?? job.repositoryName ?? "Unavailable telemetry"}</td>
    <td>{job.state}</td>
    <td>{ageDisplay(job.ageSeconds, job.startedAt)}{stale(job.ageSeconds) && <StatusBadge>Stale job telemetry</StatusBadge>}</td>
    <td>- / {job.requested.vcpu}</td>
    <td>- / {formatBytes(job.requested.memoryBytes)}</td>
    <td>- / {formatBytes(job.requested.storageBytes)}</td>
    <td>- / {job.requested.concurrency}</td>
  </>;
}

function UnassignedJobsSection({ jobs, idPrefix }: { jobs: WorkerHealth["jobs"]; idPrefix: string }) {
  return <section className="worker-health-subsection" aria-labelledby={`${idPrefix}-unassigned-jobs-heading`}>
    <h4 id={`${idPrefix}-unassigned-jobs-heading`}>Unassigned jobs</h4>
    <div className="worker-health-table-wrap">
      <table className="worker-health-table">
        <caption>Unassigned worker jobs</caption>
        <thead><tr><th scope="col">Job ID</th><th scope="col">Repository / name</th><th scope="col">Lease state</th><th scope="col">Age</th><th scope="col">vCPU</th><th scope="col">Memory</th><th scope="col">Storage</th><th scope="col">Concurrency</th></tr></thead>
        <tbody>{jobs.map((job) => <tr key={job.leaseId}><JobCells job={job} /></tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function ManagedContainersSection({ health, idPrefix }: { health: WorkerHealth; idPrefix: string }) {
  const jobsByLeaseId = new Map(health.jobs.map((job) => [job.leaseId, job]));
  const unassignedJobs = health.jobs.filter((job) => !health.containers.some((container) => container.leaseId === job.leaseId));
  return <section className="worker-health-section" aria-labelledby={`${idPrefix}-containers-heading`}>
    <h3 id={`${idPrefix}-containers-heading`}>Managed containers</h3>
    {health.containers.length === 0 ? <p className="worker-health-empty">No managed containers reported.</p> : <div className="worker-health-table-wrap">
      <table className="worker-health-table worker-health-container-table">
        <caption>Current managed containers and resource usage</caption>
        <thead><tr><th scope="col">Container</th><th scope="col">State</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Disk</th><th scope="col">Freshness</th><th scope="col">Job ID</th><th scope="col">Repository / name</th><th scope="col">Lease state</th><th scope="col">Age</th><th scope="col">vCPU</th><th scope="col">Memory</th><th scope="col">Storage</th><th scope="col">Concurrency</th></tr></thead>
        <tbody>{health.containers.map((container) => {
          const job = jobsByLeaseId.get(container.leaseId);
          return <tr key={container.containerId}>
            <th scope="row"><strong>{container.name}</strong><small><code tabIndex={0} title={container.containerId}>{shortenContainerId(container.containerId)}</code></small></th>
            <td>{container.state}</td>
            <td>{formatContainerCpu(container.cpuUsagePercent)}</td>
            <td>{formatContainerBytes(container.memoryWorkingSetBytes)}{" "}<small>{container.memoryLimitBytes == null ? "Not reported" : `of ${formatBytes(container.memoryLimitBytes)}`}</small></td>
            <td>{formatContainerBytes(container.diskUsageBytes)}{" "}<small>Writable-layer use</small></td>
            <td><time dateTime={container.sampledAt}>{formatContainerAge(container.sampledAt)}</time></td>
            {job ? <JobCells job={job} /> : <td colSpan={8}>No job assigned</td>}
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {health.jobs.length === 0 && <p className="worker-health-empty">No active jobs</p>}
    {unassignedJobs.length > 0 && <UnassignedJobsSection jobs={unassignedJobs} idPrefix={idPrefix} />}
  </section>;
}

export function WorkerHealthPanel({ workerId, health, loading = false, error, limits, showConnectionStatus = true }: WorkerHealthPanelProps) {
  const idPrefix = workerId ? `worker-health-${workerId}` : "worker-health";
  if (loading) return <section id={`${idPrefix}-panel`} className="worker-health-panel" role="status" aria-label="Live worker health"><p>Loading live health…</p></section>;
  if (error) return <section id={`${idPrefix}-panel`} className="worker-health-panel" role="alert" aria-label="Live worker health error"><p>Live health unavailable. {errorMessage(error)}</p></section>;
  if (!health) return <section id={`${idPrefix}-panel`} className="worker-health-panel" role="alert" aria-label="Live worker health error"><p>Live health unavailable. No telemetry was reported.</p></section>;
  return <section id={`${idPrefix}-panel`} className="worker-health-panel" aria-label="Live worker health">
    {showConnectionStatus && <div className="worker-health-statuses" aria-label="Worker telemetry status">
      <StatusBadge>{health.connection.state === "offline" ? "Offline" : "Online"}</StatusBadge>
      {stale(health.connection.heartbeatAgeSeconds) && <StatusBadge>Stale heartbeat</StatusBadge>}
      {stale(health.connection.doctorAgeSeconds) && <StatusBadge>Stale doctor</StatusBadge>}
      {health.connection.heartbeatAgeSeconds == null && <StatusBadge>Unavailable telemetry</StatusBadge>}
      {health.connection.doctorAgeSeconds == null && <StatusBadge>Unavailable telemetry</StatusBadge>}
    </div>}
    <UsageSection health={health} idPrefix={idPrefix} limits={limits} />
    <CacheSection health={health} idPrefix={idPrefix} />
    <ManagedContainersSection health={health} idPrefix={idPrefix} />
  </section>;
}
