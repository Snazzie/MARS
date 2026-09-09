# VM Health Workloads Implementation Plan

> **For agentic workers:** Execute inline in this session; preserve existing runtime and cache contracts.

**Goal:** Display active Hyper-V VM leases as managed workloads instead of falsely reporting unassigned jobs, while clearing the current stale RaceIQ leases.

**Architecture:** Keep the existing `WorkerHealth` payload and lease query. Make the health panel runtime-aware: container mode retains container matching, while VM mode renders active leases directly as managed workloads and does not label them unassigned. Cache inventory remains a separate WorkerCard section. Operational cleanup stops the local Mars worker before removing stale managed containers; database lease reaping remains subject to available administrative access.

**Tech Stack:** TypeScript, React, Bun tests, Docker, Windows Service Control.

## Global Constraints

- Do not change lease scheduling or resource ceilings.
- Do not merge cache inventory with job/runtime health.
- Preserve container-mode telemetry and existing API contracts.
- Use test-first changes for new dashboard behavior.

---

### Task 1: Runtime-aware health presentation

**Files:**
- Modify: `apps/web/src/components/WorkerHealthPanel.tsx`
- Test: `apps/web/src/components/WorkerHealthPanel.test.tsx`

**Interfaces:**
- Consume existing `WorkerHealth.runtimeMode`, `WorkerHealth.containers`, and `WorkerHealth.jobs` fields.
- No API or contract changes.

- [ ] Add a failing VM-mode test asserting VM jobs appear under a managed-workload section and not under “Unassigned jobs”.
- [ ] Implement a VM branch that renders each active job as a managed workload row when no container telemetry exists; retain current container matching for container mode.
- [ ] Rename only the user-facing generic heading/copy to “Managed workloads” where needed; retain container-specific wording for container mode.
- [ ] Run the focused test and verify it passes.

### Task 2: Clear current stale workloads

**Files:**
- No repository files.

- [ ] Stop `MarsWorker` from an elevated shell.
- [ ] Remove the two stale managed containers.
- [ ] Mark their active leases failed with cleanup pending using the deployment’s control-plane administrative path; do not delete database rows.

### Task 3: Verify

**Files:**
- No repository files.

- [ ] Run the focused WorkerHealthPanel test.
- [ ] Run related web component tests if focused tests pass.
- [ ] Confirm no `mars-*` job containers are recreated after the worker is stopped and leases are reaped.
