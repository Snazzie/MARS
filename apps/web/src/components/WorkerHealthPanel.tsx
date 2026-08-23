import type { ReactNode } from "react";
import type { WorkerHealth } from "@whitesmith/contracts";

const STALE_AFTER_SECONDS = 300;

type WorkerHealthPanelProps = {
  health?: WorkerHealth | null;
  loading?: boolean;
  error?: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Try again later.";
}

function formatBytes(value: string): string {
  try {
    return `${BigInt(value).toString()} B`;
  } catch {
    return `${value} B`;
  }
}

function formatTtl(seconds: number | null): string {
  return seconds == null ? "Not reported" : `${seconds / 3600} hours`;
}

function timestamp(value: string | null, fallback = "Unavailable telemetry"): ReactNode {
  if (!value) return fallback;
  return <time dateTime={value}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))}</time>;
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

function UsageSection({ health }: { health: WorkerHealth }) {
  const metric = (label: string, value: { actual: number | string; reserved: number | string; free: number | string }, bytes = false) => (
    <div className="worker-health-metric">
      <span>{label}</span>
      <strong>Actual {bytes ? formatBytes(String(value.actual)) : value.actual}</strong>
      <small>Reserved {bytes ? formatBytes(String(value.reserved)) : value.reserved} · Free {bytes ? formatBytes(String(value.free)) : value.free}</small>
    </div>
  );
  return <section className="worker-health-section" aria-labelledby="worker-health-usage-heading">
    <h3 id="worker-health-usage-heading">System usage</h3>
    <div className="worker-health-metrics">
      {metric("CPU", health.usage.cpu)}
      {metric("Memory", health.usage.memoryBytes, true)}
      {metric("Storage", health.usage.storageBytes, true)}
      {metric("Pods", health.usage.pods)}
    </div>
  </section>;
}

function CacheSection({ health }: { health: WorkerHealth }) {
  const cache = health.cache;
  const cacheStale = !cache.ready && cache.observedAt != null;
  return <section className="worker-health-section" aria-labelledby="worker-health-cache-heading">
    <h3 id="worker-health-cache-heading">Cache health</h3>
    <dl className="worker-health-details">
      <div><dt>Readiness</dt><dd>{cache.ready ? "Ready" : "Unavailable"}</dd></div>
      <div><dt>Desired TTL</dt><dd>{formatTtl(cache.desiredTtlSeconds)}</dd></div>
      <div><dt>Effective TTL</dt><dd>{formatTtl(cache.effectiveTtlSeconds)}</dd></div>
      <div><dt>Generation</dt><dd>{cache.generation ?? "No cache snapshot"}</dd></div>
      <div><dt>Entries</dt><dd>{cache.entryCount}</dd></div>
      <div><dt>Size</dt><dd>{formatBytes(cache.sizeBytes)}</dd></div>
      <div><dt>Observed</dt><dd>{timestamp(cache.observedAt)}</dd></div>
      <div><dt>Proxy status</dt><dd>{cache.ready ? "Available" : "Unavailable"}</dd></div>
    </dl>
    <div className="worker-health-statuses" aria-label="Cache health status">
      {!cache.generation && <StatusBadge>No cache snapshot</StatusBadge>}
      {cacheStale && <StatusBadge>Stale cache</StatusBadge>}
      {!cache.observedAt && <StatusBadge>Unavailable telemetry</StatusBadge>}
    </div>
    {cache.error && <div className="worker-health-error" role="alert"><strong>Cache error</strong><span>{cache.error}</span><small>Remediation: verify the worker cache service and retry the health check.</small></div>}
  </section>;
}

function JobsSection({ health }: { health: WorkerHealth }) {
  return <section className="worker-health-section" aria-labelledby="worker-health-jobs-heading">
    <h3 id="worker-health-jobs-heading">Running jobs</h3>
    {health.jobs.length === 0 ? <p className="worker-health-empty">No active jobs</p> : <div className="worker-health-table-wrap"><table className="worker-health-table"><caption>Running worker jobs</caption><thead><tr><th scope="col">Job ID</th><th scope="col">Repository / name</th><th scope="col">Lease state</th><th scope="col">Age</th><th scope="col">Requested vCPU / memory / storage / concurrency</th></tr></thead><tbody>{health.jobs.map((job) => <tr key={job.leaseId}><td>{job.jobId ?? "Unavailable telemetry"}</td><td>{job.repositoryFullName ?? job.repositoryName ?? "Unavailable telemetry"}</td><td>{job.state}</td><td>{ageDisplay(job.ageSeconds, job.startedAt)}{stale(job.ageSeconds) && <StatusBadge>Stale job telemetry</StatusBadge>}</td><td>{job.requested.vcpu} / {formatBytes(job.requested.memoryBytes)} / {formatBytes(job.requested.storageBytes)} / {job.requested.concurrency}</td></tr>)}</tbody></table></div>}
  </section>;
}

export function WorkerHealthPanel({ health, loading = false, error }: WorkerHealthPanelProps) {
  if (loading) return <section className="worker-health-panel" role="status" aria-label="Live worker health"><p>Loading live health…</p></section>;
  if (error) return <section className="worker-health-panel" role="alert" aria-label="Live worker health error"><p>Live health unavailable. {errorMessage(error)}</p></section>;
  if (!health) return <section className="worker-health-panel" role="alert" aria-label="Live worker health error"><p>Live health unavailable. No telemetry was reported.</p></section>;
  return <section id="worker-health-panel" className="worker-health-panel" aria-label="Live worker health">
    <div className="worker-health-statuses" aria-label="Worker telemetry status">
      <StatusBadge>{health.connection.state === "offline" ? "Offline" : "Online"}</StatusBadge>
      {stale(health.connection.heartbeatAgeSeconds) && <StatusBadge>Stale heartbeat</StatusBadge>}
      {stale(health.connection.doctorAgeSeconds) && <StatusBadge>Stale doctor</StatusBadge>}
      {health.connection.heartbeatAgeSeconds == null && <StatusBadge>Unavailable telemetry</StatusBadge>}
      {health.connection.doctorAgeSeconds == null && <StatusBadge>Unavailable telemetry</StatusBadge>}
    </div>
    <UsageSection health={health} />
    <CacheSection health={health} />
    <JobsSection health={health} />
  </section>;
}
