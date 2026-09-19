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

### VM template

The VM runtime uses one sealed, non-differencing VHDX as an immutable parent. The template must contain:

- the Mars Windows job agent at `C:\ProgramData\Mars\mars-job-agent.exe`;
- the GitHub Actions Runner under `C:\actions-runner`;
- a LocalSystem startup task named `MarsGuestService` that starts the job agent in guest-service mode;
- the Hyper-V Guest Service Interface;
- a generalized Windows installation prepared with Sysprep.

`deploy/workers/prepare-windows-hyperv-template.ps1` creates this artifact. It verifies the source VHDX and Actions Runner archive SHA-256 values, injects the job agent and runner, registers the startup task, removes temporary and worker identity state, generalizes the guest, compacts the VHDX, and emits a manifest containing the source and template digests.

The control plane obtains the template from either:

- development configuration: `MARS_WINDOWS_TEMPLATE_PATH` or `MARS_WINDOWS_TEMPLATE_URL` plus `MARS_WINDOWS_TEMPLATE_SHA256` (or `MARS_WINDOWS_TEMPLATE_DIGEST`); or
- a production worker release manifest at `platforms["windows-x64"].vm.template`.

The VM and container release entries are independently optional. A release may publish either runtime or both.

### Host installation

VM mode requires:

- Windows 11 Pro or Enterprise x64;
- Administrator privileges during installation;
- the Hyper-V Windows feature;
- a working Hyper-V host;
- an existing virtual switch.

The installer uses `Default Switch` unless `MARS_HYPERV_SWITCH_NAME` names another switch. It validates the switch before registering the worker service. It downloads and verifies the template, installs it at `C:\ProgramData\Mars\templates\windows-worker.vhdx`, marks it read-only, and restricts access to LocalSystem and Administrators.

VM mode does not enable the Windows Containers feature, install Docker Desktop, switch Docker engines, build a container image, or add a Docker service dependency. Container mode retains those existing behaviors.

The Mars worker service receives:

```text
MARS_WINDOWS_RUNTIME=vm
MARS_WINDOWS_TEMPLATE_PATH=C:\ProgramData\Mars\templates\windows-worker.vhdx
MARS_WINDOWS_TEMPLATE_DIGEST=sha256:<digest>
MARS_HYPERV_SWITCH_NAME=<optional override>
```

Feature installation may require a reboot. The resume task preserves the selected runtime and every artifact URL and digest needed to continue safely.

### Lease lifecycle

For each VM lease, the Hyper-V driver:

1. verifies that the requested image digest equals the installed template digest;
2. validates requested CPU, memory, storage, and concurrency against worker limits;
3. writes the decrypted lease bootstrap to a worker-local, exclusive file;
4. creates a differencing VHDX whose parent is the sealed template;
5. creates a Generation 2 VM with static memory, requested vCPU count, Secure Boot using the `MicrosoftWindows` template, automatic checkpoints disabled, and the configured virtual switch;
6. starts the VM and waits for the Hyper-V heartbeat integration service;
7. copies the bootstrap to `C:\ProgramData\Mars\bootstrap.json` through `Copy-VMFile` and the Guest Service Interface;
8. waits for the guest to shut down or for the job timeout;
9. removes the temporary host bootstrap file;
10. removes the VM and differencing disk during lease cleanup unless failed-lease preservation is enabled.

The control plane continues to encrypt the lease envelope for the worker with X25519 and AES-256-GCM. The worker decrypts it before creating the VM; plaintext bootstrap data is not sent in Hyper-V command arguments.

At worker startup, orphan reconciliation removes Mars-owned VMs matching the configured prefix. The parent template is never modified by a lease.

### Readiness and routing

A VM worker reports `runtimeMode: "vm"`, `artifactSource: "template"`, and the template digest in doctor data. It is ready only when:

- the configured template exists;
- the template digest is pinned;
- the Hyper-V host probe succeeds; and
- GitHub egress succeeds.

Windows VM pools use driver `windows-hyperv`; Windows container pools use `windows-hyperv-container`. Pool creation, default-pool selection, enablement checks, queued-job reconciliation, and atomic lease reservation all compare the pool driver with the worker's reported runtime mode.

When both runtime types are present, the existing container runtime remains the default Windows pool choice. Operators can create a VM-backed pool from a VM worker when full-guest isolation is required.

## Consequences

### Positive

- Windows jobs can run in complete, disposable Windows guests without Docker.
- Differencing disks make each lease ephemeral while avoiding a full template copy per job.
- Digest matching binds a pool and lease to the exact installed parent image.
- The immutable parent plus per-lease cleanup prevents job filesystem state from carrying into later leases.
- Container workers remain supported and can coexist with VM workers.
- Runtime selection is visible in enrollment, worker health, upgrades, pool drivers, and scheduling.

### Costs and constraints

- Operators must build, publish, and rotate a large VHDX artifact.
- Hyper-V and a usable virtual switch must be available on every VM worker host.
- VM startup consumes more time, memory, and storage than a Windows container.
- Template preparation requires guest credentials and PowerShell Direct access to the source VM.
- The current VM path supports Windows x64 guests only.
- Physical Hyper-V execution remains an operator-host verification; automated coverage uses an injected Hyper-V command runner and validates generated PowerShell commands and lifecycle behavior.

## Alternatives considered

### Replace Windows containers with VMs

Rejected. Full VMs solve workloads that need a complete guest, but container startup and operational density remain valuable. The two runtime modes have distinct requirements and should coexist.

### Run every job in the shared worker host

Rejected. Host execution would allow untrusted workflow code to modify the worker, credentials, services, and later jobs.

### Copy the full VHDX for every lease

Rejected. A read-only parent with a differencing child preserves isolation while reducing per-lease I/O and storage consumption.

### Fall back from VM to container, or container to VM

Rejected. Silent fallback changes the isolation boundary and runtime semantics. Missing artifacts, Hyper-V, Docker, or matching workers are readiness or scheduling failures.

### Use checkpoints as job templates

Rejected. Checkpoints carry more mutable VM state and complicate reproducibility. A generalized, hash-pinned parent VHDX is the release artifact and source of truth.

## Operational references

- `apps/orchestrator/src/hyperv.ts` — Hyper-V command adapter and per-lease lifecycle.
- `apps/orchestrator/src/windows-agent.ts` — runtime selection, doctor evidence, and command handling.
- `deploy/workers/install-worker.ps1` — runtime-specific host installation.
- `deploy/workers/prepare-windows-hyperv-template.ps1` — sealed template preparation.
- `apps/control-plane/src/http/worker-routes.ts` — installer metadata and template artifact serving.
- `packages/contracts/src/orchestration.ts` — runtime-driver mapping.
- `packages/contracts/src/worker-release.ts` — release artifact contract.
