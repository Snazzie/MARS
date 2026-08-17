import type { OverviewDto } from "@whitesmith/contracts";

type RunningContainer = OverviewDto["runningContainers"][number];

function formatBytes(value: number | null): string {
  if (value === null) return "Not reported";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.round(value / 1024 ** 2)} MiB`;
}

function formatCpu(value: number | null): string {
  return value === null ? "Not reported" : `${value.toFixed(1)}%`;
}

function formatSampleAge(sampledAt: string | null): string {
  if (!sampledAt) return "No telemetry sample";
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(sampledAt)) / 1000));
  return ageSeconds < 60 ? `${ageSeconds}s ago` : `${Math.round(ageSeconds / 60)}m ago`;
}

function ContainerRow({ container }: { container: RunningContainer }) {
  return <tr>
    <th scope="row"><strong>{container.jobName}</strong><small>{container.repositoryName} · {container.workflowName}</small></th>
    <td><strong>{container.workerName}</strong><small>{container.runtime}</small></td>
    <td>{formatCpu(container.cpuUsagePercent)}</td>
    <td>{formatBytes(container.memoryWorkingSetBytes)}<small>{container.memoryLimitBytes === null ? "Not reported" : `of ${formatBytes(container.memoryLimitBytes)}`}</small></td>
    <td><span>Not reported</span><small>Disk telemetry unavailable</small></td>
    <td><span>{formatSampleAge(container.sampledAt)}</span><small>started {new Date(container.startedAt).toLocaleString()}</small></td>
  </tr>;
}

export function RunningContainers({ containers }: { containers: readonly RunningContainer[] }) {
  return <section className="running-containers-panel" aria-labelledby="running-containers-heading">
    <header className="running-containers-header"><div><div className="panel-kicker">Live workload</div><h2 id="running-containers-heading">Running containers</h2></div><p>CPU and memory use reflect the latest worker sample. Disk usage is not reported yet.</p></header>
    {containers.length === 0 ? <p className="chart-empty">No containers are running.</p> : <div className="running-containers-table-wrap"><table className="running-containers-table"><caption className="sr-only">Current running containers and resource usage</caption><thead><tr><th scope="col">Container</th><th scope="col">Worker</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Disk</th><th scope="col">Freshness</th></tr></thead><tbody>{containers.map((container) => <ContainerRow key={container.id} container={container} />)}</tbody></table></div>}
  </section>;
}
