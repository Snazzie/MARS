# Windows Hyper-V Template Worker Design

## Goal

Run Windows workers with concurrent Windows and Linux guests using Hyper-V Gen 2 virtual machines. Use downloaded vendor VMs as source artifacts, derive sealed Whitesmith templates, and never depend on Docker engine mode switching.

## Image supply chain

Vendor images are inputs, not production job images:

- Microsoft Windows 11 Enterprise Evaluation Hyper-V Gen 2 VHDX for `windows-x64`.
- Official Ubuntu Hyper-V/cloud image for `linux-x64`.

Each source download is verified against a configured SHA-256 and recorded in a manifest with source URL, publisher/version, and source digest. A temporary VM is created to install the Whitesmith guest service and compiled job agent, configure automatic startup and readiness signaling, remove users, credentials, machine identity, keys, logs, caches, and runner registration, then generalize where supported. The VM is shut down, compacted, sealed, and hashed.

The sealed-template manifest records:

- guest platform;
- source URL and source digest;
- sealed VHDX digest;
- Hyper-V generation and firmware requirements;
- guest-agent version;
- required integration services;
- preparation timestamp.

Workers and the control plane accept only manifest-pinned sealed templates. A mutable URL, checksum mismatch, wrong platform/generation, or missing guest-service contract is fatal. No fallback to Docker, WSL, SSH, containers, or unpinned images is permitted.

## Worker contract

A Windows worker uses the `windows-hyperv` driver directly. It advertises `windows-x64` by default and may advertise `linux-x64` only after a valid Linux template passes preflight:

```json
{
  "platform": "windows-x64",
  "guestPlatforms": ["windows-x64", "linux-x64"],
  "driver": "windows-hyperv"
}
```

Capability changes require the worker to be drained and have zero active leases. The worker remains drained until it acknowledges the new configuration as ready. No live guest-platform mutation is allowed.

## Lease lifecycle

1. The scheduler selects a worker advertising the requested guest platform.
2. The worker verifies the lease image digest against the selected template.
3. It creates a per-lease differencing VHDX and never boots the sealed parent directly.
4. It creates a Generation 2 VM with bounded vCPU, memory, disk, and network settings.
5. It copies encrypted bootstrap data through Hyper-V Guest Service Interface.
6. It starts the VM and waits for the guest-service readiness signal.
7. The guest service launches the Actions Runner/job agent and reports attestation.
8. Logs and completion state use the existing worker socket protocol.
9. The worker stops the VM, deletes the differencing disk, and removes the VM.
10. Failures emit lease failure state and perform best-effort cleanup before reuse.

## Distribution

The control plane serves cached template artifacts through authenticated endpoints. Workers stream each artifact to a temporary file, hash it, atomically rename it into a local cache, and reuse only matching content. Missing or invalid templates keep the worker unready.

The installer validates Hyper-V, Gen 2 support, virtualization extensions, storage, networking, manifest integrity, and every configured template before registering the service. The native worker runs as LocalSystem because Hyper-V management and machine-scoped identity are required.

## Components

- Contract schemas for guest platforms, template manifests, and worker configuration.
- Database persistence for worker guest capabilities and template configuration.
- Control-plane template metadata and authenticated artifact routes.
- Hyper-V runtime adapter for VM creation, resource assignment, bootstrap transfer, start/stop, cleanup, and orphan recovery.
- Windows worker enrollment and reusable worker socket client.
- Guest service integration for Windows and Linux startup, bootstrap consumption, callbacks, and runner completion.
- Installer and operator template-preparation scripts.
- UI controls for guest capability configuration and drained-worker restrictions.

## Verification

Tests must defend observable behavior:

- manifest parsing and digest enforcement;
- source and sealed-template checksum failures;
- VM creation, differencing disks, resource limits, bootstrap transfer, readiness, cleanup, and orphan recovery;
- Windows/Linux capability routing;
- drained-worker configuration changes;
- installer failures for missing, corrupt, or incompatible templates;
- control-plane artifact streaming and cache integrity.

Smoke verification will launch the control plane, serve a local manifest/template fixture, exercise worker preflight and routing, and verify that a lease creates and cleans up the expected Hyper-V command sequence through a deterministic fake Hyper-V adapter. Physical Hyper-V execution remains an operator-host verification because the development environment may not expose nested Hyper-V.
