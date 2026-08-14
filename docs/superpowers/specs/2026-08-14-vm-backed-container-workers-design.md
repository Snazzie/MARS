# VM-Backed Container Workers Design

## Goal

Run potentially hostile GitHub Actions jobs with disposable, hardware-backed sandboxes that become runner-ready within 15 seconds when images are already present. Linux and Windows jobs must execute concurrently on separate native workers.

## Decision

Whitesmith will use one immutable container per lease while retaining a virtual-machine security boundary:

- `whitesmith-windows-x64`: a native Windows worker runs Windows containers with mandatory Hyper-V isolation.
- `whitesmith-linux-x64`: a native Linux worker runs Linux containers with Kata Containers through containerd/K3s.
- `whitesmith-macos-arm64`: the existing Tart VM path remains unchanged.

Windows process-isolated containers and Linux `runc` containers are prohibited for job execution. The worker must fail closed when the configured isolation runtime is unavailable. There is no runtime fallback.

Full per-job Hyper-V VMs, differencing VHDX files, checkpoints, and warm VM slots leave the active Windows path. A future workload requiring a desktop, drivers, or full machine semantics must use a separately named worker capability rather than silently changing the Windows container pool.

## Threat model

Job code may be deliberately hostile. It may attempt container escape, credential theft, persistence, denial of service, network scanning, or interference with concurrent jobs.

The privileged worker service is the only process allowed to access Docker, containerd, K3s, HCS, or Kata control interfaces. A job sandbox receives none of the following:

- Docker, containerd, CRI, or Kubernetes credentials or sockets;
- arbitrary host filesystem mounts;
- host process, network, IPC, user, or cgroup namespaces;
- privileged mode or host devices;
- reusable GitHub credentials;
- another lease's bootstrap, work volume, logs, or runtime objects.

The JIT runner configuration is scoped to one runner and one job. It is written to a lease-specific directory with restrictive host permissions, mounted only into that lease, consumed by the job agent, and removed during cleanup.

## Worker capabilities and routing

Each worker advertises only its native guest platform:

```text
Linux worker   platform=linux-x64    guestPlatforms=[linux-x64]    driver=kata-k3s
Windows worker platform=windows-x64  guestPlatforms=[windows-x64]  driver=windows-hyperv-container
macOS worker   platform=macos-arm64  guestPlatforms=[macos-arm64]  driver=tart-vm
```

The control plane maps the existing composite trigger labels directly to these capabilities. Linux and Windows jobs run in parallel because they are dispatched to independent workers; Docker Desktop engine switching is not part of production operation.

## Worker readiness

A worker reports ready only after all checks succeed:

1. The runtime daemon is reachable.
2. The required isolation runtime is installed and enabled.
3. The configured image is an immutable `repository@sha256:<64 lowercase hex>` reference.
4. The image exists locally and reports the expected digest.
5. A minimal sandbox probe starts with the required isolation mode and exits successfully.
6. The worker can inspect the probe and verify Hyper-V isolation on Windows or the configured Kata runtime class on Linux.
7. Configured CPU, memory, storage, and concurrency limits fit host capacity.
8. Orphan reconciliation has completed.

A failed probe keeps the worker unready and drained. It must never retry under weaker isolation.

## Lease lifecycle

1. The scheduler selects a connected, ready, non-draining worker for the requested composite label.
2. The control plane creates an ephemeral GitHub runner JIT configuration and encrypts the lease envelope to the worker identity.
3. The worker validates the command, lease ID, nonce, platform, expiry, image digest, and resource limits.
4. The worker creates a unique sandbox name and a restrictive lease directory containing the bootstrap file.
5. The runtime creates one sandbox with ownership and lease labels, resource limits, an isolated writable work area, controlled networking, and only the bootstrap mount.
6. The image entrypoint starts `whitesmith-job-agent`, which consumes the bootstrap and launches the Actions Runner using the encoded JIT configuration.
7. The sandbox executes at most one GitHub job. The worker reports attestation, runner completion, and diagnostics through the existing event protocol.
8. Every terminal path force-stops and removes the sandbox, work storage, bootstrap material, and in-memory lease record.
9. On service restart, the worker enumerates only objects with the Whitesmith ownership label, reconciles their lease state, and removes stale owned objects. It never modifies unrelated runtime objects.

Sandboxes are not reused. Initial performance relies on pre-pulled immutable image layers rather than warm containers. A warm mechanism is outside scope unless measured pre-pulled startup cannot meet the 15-second target.

## Windows runtime

The initial development runtime is Docker Desktop or Moby using Windows-container mode. A production installation requiring vendor support should use Mirantis Container Runtime; the worker integrates through the Docker-compatible CLI contract.

Every create command includes Hyper-V isolation explicitly. Preflight creates a disposable probe and inspects it before accepting work. Process isolation is a fatal configuration error.

The Windows image is based on a compatible Microsoft Windows Server Core image. The initial tool profile contains:

- GitHub Actions Runner;
- `whitesmith-job-agent.exe`;
- PowerShell and CMD;
- Git;
- Node.js;
- .NET SDK;
- MSVC Build Tools only if the resulting image still satisfies the measured startup gate.

Windows containers intentionally do not support interactive desktop applications, RDP, kernel drivers, or GitHub Actions' Linux-only job/service/container-action features.

## Linux runtime

The Linux worker uses K3s/containerd with a dedicated `whitesmith-kata` RuntimeClass backed by Kata Containers. The job Pod must select that runtime class explicitly. Admission or preflight rejects Pods that resolve to ordinary `runc`.

Each lease uses an isolated bootstrap Secret, a disposable work volume, strict resource requests and limits, no service-account token, no host paths, no privileged containers, and no added Linux capabilities. Owned Secrets, Pods, and volumes carry lease labels and are deleted together.

The initial Linux image contains the Actions Runner, Whitesmith job agent, Bash, Git, Node.js, CA certificates, and the selected build tool profile.

## Image supply chain

Job images are built in CI from pinned base images and pinned tool inputs. A successful build emits:

- immutable image digest;
- source and tool version manifest;
- SBOM;
- vulnerability scan result;
- signature and provenance;
- job-agent and runner versions.

Workers accept only configured digests. Image rollout drains affected workers, pre-pulls and verifies the new digest, runs the isolation probe, then returns the worker to service. Mutable tags may be human-readable aliases but never appear in lease configuration.

## Failure handling

- Provisioning, isolation verification, digest mismatch, and bootstrap errors emit `lease.failed` with `provisioning_failed`.
- Nonzero runner termination and runtime wait failures emit `runner_failed`.
- Stop, remove, or lease-material deletion failures emit `cleanup_failed` and keep the worker drained until reconciliation succeeds.
- Timeouts force-stop the sandbox before reporting the terminal event.
- Secret values never appear in argv, structured logs, diagnostics, container labels, or runtime object names.

Cleanup is idempotent. Replayed stop and remove operations succeed when the sandbox is already absent.

## Feasibility gate

Before changing the active Windows worker, a host-level proof must demonstrate:

1. Windows engine mode and Hyper-V isolation are available.
2. A digest-pinned Server Core sandbox reports Hyper-V isolation.
3. The Whitesmith image starts the job agent and executes synthetic CMD and PowerShell workloads.
4. A one-use GitHub JIT runner executes a real smoke job.
5. Force-removal during execution leaves no owned container or bootstrap data.
6. A pre-pulled image becomes runner-ready within 15 seconds over repeated runs.
7. Process isolation, mutable images, wrong digests, and unavailable Windows engine mode fail closed.

Failure of isolation, execution, cleanup, or compatibility blocks the cutover. A startup miss triggers image profiling and tool-profile reduction before any warm-container design is considered.

## Migration

The cutover is clean:

1. Prove the Windows feasibility gate without changing production dispatch.
2. Add the Windows Hyper-V-container driver and image contract.
3. Migrate contracts, control-plane dispatch, installer configuration, worker preflight, tests, and dashboard driver names.
4. Remove the active Windows VHDX/checkpoint runtime and obsolete template preparation path.
5. Deploy and smoke one drained Windows worker, then enable it.
6. Implement the real Linux Kata driver and Linux worker lease loop.
7. Deploy one Linux worker and verify a real JIT job.
8. Dispatch Linux and Windows smoke jobs concurrently and verify temporal overlap, isolation, outcomes, and cleanup.

## Verification

Permanent tests cover exact runtime arguments/manifests, fail-closed isolation checks, immutable digests, secret exclusion, resource propagation, lifecycle event mapping, idempotent cleanup, and orphan ownership filtering.

Host-level smoke tests exercise the actual Windows Hyper-V-container runtime and actual Linux Kata runtime. The final cross-platform smoke starts one job for each composite label, proves both runners were active concurrently, and verifies that both sandboxes and all lease material were removed.