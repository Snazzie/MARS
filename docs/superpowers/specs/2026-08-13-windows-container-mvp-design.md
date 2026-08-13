# Windows Container MVP Design

## Goal

Run Windows GitHub Actions jobs on a Windows worker using Docker Windows containers with mandatory Hyper-V isolation. The MVP must not fall back to process isolation.

## Runtime

The Windows worker uses Docker in Windows-container mode. Each lease creates a disposable container with `--isolation=hyperv` from an immutable Windows base image digest. The container runs the Actions Runner and `whitesmith-job-agent` guest service. The existing worker enrollment, encrypted lease bootstrap, command acknowledgment, lifecycle events, and cleanup protocol remain unchanged.

The existing Generation 2 VHDX Hyper-V driver remains available but is not selected by the MVP Windows worker path. Linux guests are not supported by this Windows-container MVP.

## Preflight and configuration

The installer checklist must verify:

- Elevated Administrator PowerShell.
- Windows x64.
- Windows Containers feature.
- Hyper-V support.
- Docker CLI and daemon availability.
- Docker is operating in Windows-container mode.
- `docker run --rm --isolation=hyperv` succeeds with the configured immutable image.
- The configured image digest is immutable and available locally or pullable from the configured registry.
- Control-plane connectivity and one-use enrollment code.

Failure of any Hyper-V isolation check is fatal. The installer must never silently use process isolation.

## Lease lifecycle

1. Validate the encrypted lease bootstrap and requested Windows guest platform.
2. Create a unique container name and isolated temporary bootstrap directory.
3. Write the exact bootstrap payload with restrictive ACLs.
4. Start the container with Hyper-V isolation, pinned image, required resource limits, and only the minimal bootstrap exposure.
5. Run the guest service and Actions Runner inside the container.
6. Accept only the authenticated one-use completion callback for the lease.
7. Map successful, runner-failed, provisioning-failed, timeout, and cleanup outcomes to existing lifecycle events.
8. Stop and remove the container on every terminal path; delete host bootstrap material in a `finally` path.
9. On worker restart, enumerate only containers carrying the Whitesmith lease label and reconcile orphaned containers before accepting new work.

No host Docker socket, arbitrary host filesystem path, or reusable credential is exposed inside a job container.

## Image contract

The image is operator-built and digest-pinned. It must contain:

- A compatible Windows Server Core base.
- Actions Runner at the configured runner root.
- `whitesmith-job-agent.exe`.
- The Windows guest-service startup command.
- Required networking and shell support.

The MVP does not accept third-party modified images, mutable tags, or an unverified local image. Image preparation emits the digest and a manifest for control-plane configuration.

## Control-plane and API

Pools continue to identify the guest platform as `windows-x64`; the worker driver becomes the Windows-container driver for this MVP. Lease dispatch sends a dedicated container create command rather than `hyperv.create_lease`. Existing encrypted `guestPlatform`, image digest, resources, nonce, callback URL, and callback token fields remain bound to the lease.

## Testing

Add unit coverage for:

- Exact Docker arguments, including `--isolation=hyperv`.
- Rejection of process isolation and mutable image tags.
- Resource and label propagation.
- No bootstrap secret in command logs or argument strings.
- Callback authentication and timeout mapping.
- Idempotent replay and orphan cleanup.
- Installer preflight failures for Linux Docker mode, missing Docker, missing Hyper-V isolation, and digest mismatch.

End-to-end validation requires a Windows host with Docker Windows containers enabled and a prepared pinned Windows image.
