import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkerDetail } from "@mars/contracts";
import { getWorkers } from "../api.ts";
import { EnrollmentPanel } from "../components/EnrollmentPanel.tsx";
import { PendingWorkerRequests, pendingWorkerQueryOptions } from "../components/PendingWorkerRequests.tsx";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function workerRefetchInterval(workers: Array<Pick<WorkerDetail, "admissionState" | "configurationState" | "draining" | "activeSandboxes"> & { doctor?: WorkerDetail["doctor"] }> | undefined): 2000 | false {
  return workers?.some((worker) => worker.admissionState === "adopted" && (worker.configurationState === "applying" || worker.doctor?.runtimeBuildState === "building" || (worker.draining && worker.activeSandboxes > 0))) ? 2_000 : false;
}

export function WorkersPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["org", organizationId, "workers", includeInactive],
    queryFn: () => getWorkers(organizationId, includeInactive),
    enabled: Boolean(organizationId),
    staleTime: 10_000,
    refetchInterval: (current) => workerRefetchInterval(current.state.data?.items),
  });
  const pendingQuery = useQuery(pendingWorkerQueryOptions());
  function invalidate() { void queryClient.invalidateQueries({ queryKey: ["pending-workers"] }); void queryClient.invalidateQueries({ queryKey: ["org", organizationId, "workers"] }); }
  return <>
    <header className="page-header workers-header">
      <div><p className="eyebrow">Worker fleet</p><h1>Know where work lands.</h1><p className="page-description">Workers registered with the control plane.</p></div>
    </header>
    <button type="button" className="control-button" aria-expanded={enrollmentOpen} aria-controls="worker-enrollment" onClick={() => setEnrollmentOpen((open) => !open)}>{enrollmentOpen ? "Close enrollment" : "Enroll worker"}</button>
    {enrollmentOpen && <div id="worker-enrollment"><EnrollmentPanel workers={pendingQuery.data ?? []} onConnected={invalidate} /></div>}
    {organizationId === "all" && <PendingWorkerRequests organizationId={organizationId} workers={pendingQuery.data ?? []} error={pendingQuery.error} isLoading={pendingQuery.isLoading} retry={() => void pendingQuery.refetch()} />}
    <div className="worker-list-toolbar"><label><input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.currentTarget.checked)} /> Show rejected and revoked workers</label></div>
    <QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} operationLabel="worker fleet" />
    {query.data && <div className="list-panel worker-list">{query.data.items.map((worker) =>
      <Link className="list-row worker-list-row" key={worker.id} to="/workers/$workerId" params={{ workerId: worker.id }}>
        <div className="worker-list-identity">
          <div className="worker-list-name"><span className={`status-dot status-${worker.connectionState}`} aria-hidden="true" /><h2>{worker.name}</h2></div>
          <p className="worker-meta">{worker.platform} <span aria-hidden="true">·</span> {worker.driver}</p>
        </div>
        <div className="worker-list-summary">
          <span className={`status-pill status-${worker.connectionState}`}>{worker.connectionState}</span>
          {worker.draining && <span className="status-pill status-draining">draining</span>}
          <span className="worker-list-leases">{worker.activeSandboxes} active {worker.activeSandboxes === 1 ? "lease" : "leases"}</span>
          <span className="worker-list-arrow" aria-hidden="true">→</span>
        </div>
      </Link>
    )}</div>}
  </>;
}
