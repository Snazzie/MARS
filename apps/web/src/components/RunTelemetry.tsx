type TelemetryProps = { queuedAt: string; startedAt: string | null; completedAt: string | null };

function differenceMs(from: string | null, to: string | null) {
  if (!from || !to) return null;
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function lifecycleMetrics(queuedAt: string, startedAt: string | null, completedAt: string | null) {
  return {
    startDelayMs: differenceMs(queuedAt, startedAt),
    runDurationMs: differenceMs(startedAt, completedAt),
    lifecycleMs: differenceMs(queuedAt, completedAt),
  };
}

export function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="telemetry-metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

export function RunTelemetry({ queuedAt, startedAt, completedAt }: TelemetryProps) {
  const metrics = lifecycleMetrics(queuedAt, startedAt, completedAt);
  return <section className="run-telemetry" aria-label="Run telemetry">
    <Metric label="Job created" value={formatTimestamp(queuedAt)} />
    <Metric label="Time to start" value={startedAt ? formatDuration(metrics.startDelayMs) : "Waiting to start"} />
    {startedAt && <Metric label="Run duration" value={completedAt ? formatDuration(metrics.runDurationMs) : `Running · ${formatDuration(differenceMs(startedAt, new Date().toISOString()))}`} />}
    {completedAt && <Metric label="Total lifecycle" value={formatDuration(metrics.lifecycleMs)} />}
  </section>;
}
