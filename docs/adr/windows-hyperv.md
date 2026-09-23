# Windows Hyper-V Worker Runtime

## Status

Accepted.

## Context

Mars already supports Windows jobs through Docker Windows containers with mandatory Hyper-V isolation. That runtime remains useful for fast startup and a compact worker footprint, but it also requires Docker Desktop, the Windows container engine, and a compatible container image.

Some Windows workloads require a complete Windows guest instead of a container. The worker therefore needs an optional VM runtime that:

- does not install or invoke Docker;
- preserves the existing enrollment, scheduling, encrypted lease dispatch, resource policy, and cleanup lifecycle;
- boots every job from a known, hash-pinned Windows image;
- prevents one job from modifying the template used by later jobs;
- keeps the existing Windows container runtime available;
- exposes the selected runtime to pool routing and operator workflows instead of silently falling back between isolation mechanisms.

## Decision

Windows x64 workers support two explicit runtime modes:

| Installer value | Runtime driver | Lease command | Isolation unit |
| --- | --- | --- | --- |
| `container` | `windows-hyperv-container` | `windows-container.create_lease` | Hyper-V-isolated Docker container |
| `vm` | `windows-hyperv` | `hyperv.create_lease` | Disposable Hyper-V Generation 2 VM |

The dashboard enrollment flow selects the mode and emits it as `-WindowsRuntime 'container'` or `-WindowsRuntime 'vm'`. The installer persists the choice as `MARS_WINDOWS_RUNTIME`. Upgrades preserve the installed runtime mode.

There is no runtime fallback. A VM worker cannot accept a container pool, and a container worker cannot accept a VM pool. Runtime mode is included when deriving the pool driver, checking worker compatibility, reserving leases, and dispatching worker commands.

### Golden checkpoint artifact

The VM runtime uses one exported, saved Standard checkpoint as its immutable
source. The checkpoint must contain:

- the Mars Windows job agent at `C:\ProgramData\Mars\mars-job-agent.exe`;
- the GitHub Actions Runner under `C:\actions-runner`;
- a LocalSystem startup task named `MarsGuestService` that starts the job agent in guest-service mode;
- the Hyper-V Guest Service Interface; and
- a signed-in desktop with the guest agent waiting for bootstrap.

`deploy/workers/prepare-windows-hyperv-checkpoint.ps1` exports the selected
checkpoint, records hashes for every exported file, packages the export as
`windows-worker-checkpoint.zip`, and creates a digest-identical backup.

The control plane obtains the checkpoint archive from either:

- development configuration: `MARS_WINDOWS_CHECKPOINT_PATH` or
  `MARS_WINDOWS_CHECKPOINT_URL` plus `MARS_WINDOWS_CHECKPOINT_SHA256` (or
  `MARS_WINDOWS_CHECKPOINT_DIGEST`); or
- a production worker release manifest at
  `platforms["windows-x64"].vm.checkpoint`.

The VM and container release entries are independently optional. A release may publish either runtime or both.

### Host installation

VM mode requires:

- Windows 11 Pro or Enterprise x64;
- Administrator privileges during installation;
- the Hyper-V Windows feature;
- a working Hyper-V host;
- an existing virtual switch.

The installer uses `Default Switch` unless `MARS_HYPERV_SWITCH_NAME` names another switch. It validates the switch, downloads and verifies the checkpoint ZIP, extracts it under `C:\ProgramData\Mars\checkpoints\<sha256>`, verifies one `.vmcx` and the embedded manifest, marks the export read-only, and restricts access to LocalSystem and Administrators.

VM mode does not enable the Windows Containers feature, install Docker Desktop, switch Docker engines, build a container image, or add a Docker service dependency. Container mode retains those existing behaviors.

The Mars worker service receives:

```text
MARS_WINDOWS_RUNTIME=vm
MARS_WINDOWS_CHECKPOINT_PATH=C:\ProgramData\Mars\checkpoints\<sha256>
MARS_WINDOWS_CHECKPOINT_DIGEST=sha256:<digest>
MARS_HYPERV_SWITCH_NAME=<optional override>
```

Feature installation may require a reboot. The resume task preserves the selected runtime and every artifact URL and digest needed to continue safely.

### Lease lifecycle

For each VM lease, the Hyper-V driver:

1. verifies that the requested image digest equals the installed checkpoint archive digest;
2. validates requested CPU, memory, storage, and concurrency against worker limits;
3. writes the decrypted lease bootstrap to a worker-local, exclusive file;
4. imports the checkpoint with `Import-VM -Copy -GenerateNewId` into a lease-specific directory;
5. applies the requested static memory and vCPU count, disables automatic checkpoints, and connects the configured virtual switch;
6. resumes the saved VM and waits for the Hyper-V heartbeat integration service;
7. copies the bootstrap to `C:\ProgramData\Mars\bootstrap.json` through `Copy-VMFile` and the Guest Service Interface;
8. waits for the guest to shut down or for the job timeout;
9. removes the temporary host bootstrap file; and
10. removes the imported VM and all lease-specific copied files during cleanup.

The control plane continues to encrypt the lease envelope for the worker with X25519 and AES-256-GCM. The worker decrypts it before creating the VM; plaintext bootstrap data is not sent in Hyper-V command arguments.

At worker startup, orphan reconciliation removes Mars-owned VMs and lease directories matching the configured prefix. The installed checkpoint export is never modified by a lease.

### Readiness and routing

The worker is ready only when:
- the configured extracted checkpoint directory exists;
- the checkpoint archive digest is pinned; and
- the Hyper-V host probe succeeds.

GitHub egress is not a worker-daemon readiness prerequisite. The control plane performs authenticated GitHub operations, while job runtimes retain their normal GitHub network access.

Windows VM pools use driver `windows-hyperv`; Windows container pools use `windows-hyperv-container`. Pool creation, default-pool selection, enablement checks, queued-job reconciliation, and atomic lease reservation all compare the pool driver with the worker's reported runtime mode.

When both runtime types are present, the existing container runtime remains the default Windows pool choice. Operators can create a VM-backed pool from a VM worker when full-guest isolation is required.

## Consequences

### Positive

- Windows jobs can run in complete, disposable Windows guests without Docker.
- Saved-state restore avoids OOBE and resumes the Mars-ready desktop and guest agent.
- Digest matching binds a pool and lease to the exact installed checkpoint archive.
- The immutable export plus per-lease cleanup prevents job filesystem state from carrying into later leases.
- Container workers remain supported and can coexist with VM workers.
- Runtime selection is visible in enrollment, worker health, upgrades, pool drivers, and scheduling.

### Costs and constraints

- Operators must publish and rotate a large checkpoint ZIP.
- Hyper-V and a usable virtual switch must be available on every VM worker host.
- Importing a copied checkpoint consumes more storage and I/O than a differencing disk.
- Preparing the source checkpoint requires installing and validating the guest agent before capture.
- The current VM path supports Windows x64 guests only.
- Physical Hyper-V execution remains an operator-host verification; automated coverage uses an injected Hyper-V command runner and validates generated PowerShell commands and lifecycle behavior.

## Alternatives considered

### Replace Windows containers with VMs

Rejected. Full VMs solve workloads that need a complete guest, but container startup and operational density remain valuable. The two runtime modes have distinct requirements and should coexist.

### Run every job in the shared worker host

Rejected. Host execution would allow untrusted workflow code to modify the worker, credentials, services, and later jobs.

### Use a generalized VHDX parent

Rejected. Cold boot enters OOBE and does not preserve the signed-in Mars-ready
desktop or a running guest agent waiting for bootstrap.

### Fall back from VM to container, or container to VM

Rejected. Silent fallback changes the isolation boundary and runtime semantics. Missing artifacts, Hyper-V, Docker, or matching workers are readiness or scheduling failures.

### Maintain a persistent warm clone pool

Deferred. Pre-imported slots can reduce dispatch latency, but on-demand
`Import-VM -Copy -GenerateNewId` is the smallest production path. Add a warm
pool only if measured import latency requires it.

## Operational references

- `apps/orchestrator/src/hyperv.ts` — Hyper-V command adapter and per-lease lifecycle.
- `apps/orchestrator/src/windows-agent.ts` — runtime selection, doctor evidence, and command handling.
- `deploy/workers/install-worker.ps1` — runtime-specific host installation.
- `deploy/workers/prepare-windows-hyperv-checkpoint.ps1` — checkpoint export, archive, manifest, and backup preparation.
- `apps/control-plane/src/http/worker-routes.ts` — installer metadata and checkpoint artifact serving.
- `packages/contracts/src/orchestration.ts` — runtime-driver mapping.
- `packages/contracts/src/worker-release.ts` — release artifact contract.
