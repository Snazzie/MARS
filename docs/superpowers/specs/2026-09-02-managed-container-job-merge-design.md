# Managed Container and Job Merge Design

## Goal

Present each managed container and its one-to-one worker job as a single dashboard workload row without changing runtime scheduling, persistence, or the worker health API contract.

## Invariants

- Container/job association is by exact `leaseId` equality.
- A container has zero or one matching job.
- Every container is rendered, including containers without a matching job.
- Every job is rendered; jobs without a matching container appear as unassigned.
- Missing job data is represented textually as `No job assigned`, never as fabricated zero values.
- Existing resource telemetry and freshness values remain unchanged.

## Architecture and Data Flow

The control-plane response remains the existing `WorkerHealth` shape with separate `containers` and `jobs` arrays. `WorkerHealthPanel` creates a lease-ID lookup for jobs and renders a single managed-container table. Container columns retain container name, state, CPU, memory, disk, and freshness. Job columns add job ID, repository/name, lease state, age, vCPU, memory, storage, and concurrency when a match exists.

After the container rows, the panel renders an `Unassigned jobs` subsection only when jobs have no matching container. This preserves evidence of inconsistent or delayed telemetry without changing the API or hiding data.

No changes are made to the worker protocol, database schema, scheduler, lease lifecycle, API schemas, or polling behavior.

## Accessibility and Empty States

The merged table has one caption and explicit column headers. Existing worker-specific ID prefixes remain stable. The managed-container empty state remains `No managed containers reported.` If containers exist but none have jobs, rows identify that state explicitly. The unassigned subsection is omitted when empty.

## Testing

Component tests cover:

1. A job joins the container with the same lease ID.
2. A container without a job renders `No job assigned`.
3. A job without a container appears under `Unassigned jobs`.
4. Empty container and job inventories preserve the existing empty state.
5. Existing resource formatting and accessibility markup remain valid.

## Scope

Expected implementation files are `apps/web/src/components/WorkerHealthPanel.tsx` and `apps/web/src/components/WorkerHealthPanel.test.tsx`. Fixtures may be adjusted only as needed to express the merged contract.
