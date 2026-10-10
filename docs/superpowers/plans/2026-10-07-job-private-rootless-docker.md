# Job-Private Rootless Docker Build Capability

**Status:** Parked at the feasibility gate. No product changes have been made.

## Goal

Add the standalone job label `mars-docker-build`, enabling an opted-in job to run Docker builds through a job-private rootless daemon. The intended support target in the approved plan is Linux ARM64 Docker workers and Windows ARM64 workers running Linux ARM64 Docker engines. The outer job container remains unprivileged, with existing security profiles and no host Docker socket exposure.

## Blocking feasibility gate

Before any product changes, prove the exact unprivileged nested-Docker configuration on both target engines. The original approved plan explicitly disallows x64 emulation or substitution, privileged Docker-in-Docker, host Docker access, or a VM.

A later user instruction requested a Windows x86-only probe. That probe did not run:

- The available `desktop-windows` engine reports `OS=windows`, `Arch=x86_64`, kernel `10.0 26300 (26100.1.amd64fre_ge_release.240331-1435)`, and no security options. It cannot run the Linux rootless-Docker probe.
- The `desktop-linux` endpoint is `npipe:////./pipe/dockerDesktopLinuxEngine`; `docker info` against it timed out after 20 seconds.
- No probe container or probe-owned resources were created.

A successful x86-only probe would not satisfy the ARM64 support gate or authorize product changes. A responsive Linux engine on the Windows x86 worker is needed to continue that probe-only check. Product implementation still requires an explicit support-scope revision and proof on both intended targets.

### Required probe

Use the existing ARM64 job image and candidate digest on each actual Linux ARM64 engine. Confirm `/etc/os-release`; install Docker Engine/CLI/Buildx plus rootless prerequisites from Docker's signed official APT repository. Configure UID/GID 1000 (`mars-docker`), subordinate IDs 100000–165535, `HOME=/home/mars-docker`, mode-0700 `XDG_RUNTIME_DIR=/home/mars-docker/run`, and `DOCKER_HOST=unix:///home/mars-docker/run/docker.sock`.

Run `dockerd-rootless.sh --storage-driver=vfs` as the non-root account, using rootlesskit/slirp4netns with host-loopback access disabled. Keep daemon state in the outer writable layer. Use the actual worker network and CPU/memory/swap limits. No privileged mode, added capabilities, host namespaces, writable host cgroups, security-profile overrides, host socket/binds, sidecar, TCP API, or host-wide security changes.

On both hosts, record `docker info` OS, architecture, kernel, security options and candidate digest. Require rootless security options, scratch build/create/copy round-trip, and digest-pinned ARM64 fixture build/run. Inspect outer HostConfig for the absence of privileged mode, added capabilities, profile overrides, and host socket binds. Run two outer jobs concurrently and prove their images/containers are isolated from each other and from the host daemon. Observe nested CPU/memory charged to outer limits. Remove/recreate an outer job and verify all private state is gone. Preserve exact errors and probe configuration on failure; remove only probe-owned resources and stop.

## Implementation plan after both feasibility probes pass

1. **Private daemon lifecycle:** Add proven packages/account setup to `images/jobs/linux-arm64/Containerfile` without changing ordinary runner behavior. Add optional `docker` to guest bootstrap and implement `apps/job-agent/src/private-docker.ts` with `runWithPrivateRootlessDocker(run)`. For opted-in jobs, start the daemon as `mars-docker`, give only the runner access to the private socket, wait up to 60 seconds for rootless `docker info`, and do not launch the runner on startup failure. Daemon loss must terminate/fail the runner. Shut down and wait for the daemon in `finally`, preserving normal runner exit status. Keep existing runner/cache/certificate lifecycle and outer-container crash cleanup. Do not claim disk quotas.

2. **Readiness evidence:** Add optional `rootlessDockerReady` to worker runtime capability. Probe the configured image/runtime with a temporary managed container that proves rootless startup and scratch build/create/copy; clean up in `finally`, and remove stale `mars.rootless-docker-probe=true` containers at startup. Probe at startup/configuration/image changes and before Docker-required leases, not each heartbeat. Publish readiness through Linux and Windows agents, but only Linux ARM64 `linux-docker-container` capabilities may advertise true. Scheduler readiness must come from fresh selected platform/driver/image evidence.

3. **Job-wide label parsing:** Export `DOCKER_BUILD_RUNNER_LABEL = "mars-docker-build"`. Extend `parseJobRunnerLabels` to return `{ options, maxRetries, docker }`; recognize the label case-insensitively after trimming, remove it from routing input, and reject duplicates, malformed lookalikes, and capability-only jobs. Keep composite route grammar unchanged. Update complete-job-label consumers and preserve the capability and retry labels during DB label optimization. Focused resource edits must reject silently adding/removing Docker capability and preserve the current capability label's casing/order.

4. **Scheduling and integrity:** Gate every routing alternative on positive `rootlessDockerReady`; use existing `worker_runtime_not_ready` for unmet capability. Keep route precedence and resources separate from job-wide capability. Carry `docker: true` through reconciliation into the authenticated encrypted bootstrap; omit false for compatibility. Linux container provisioning must recheck the probe and reject non-ARM64 use. Other runtime drivers must reject true rather than ignore it. Keep complete requested labels, including `mars-docker-build`, in GitHub JIT registration.

## Files identified

- `packages/contracts/src/runner-labels.ts`
- `packages/contracts/src/orchestration.ts`
- `packages/db/src/job-label-recommendations.ts`
- `apps/control-plane/src/scheduler.ts`
- `apps/control-plane/src/workflow-pr.ts`
- `apps/control-plane/src/job-reconciler.ts`
- `apps/orchestrator/src/linux-container.ts`
- `apps/orchestrator/src/linux-agent.ts`
- `apps/orchestrator/src/windows-agent.ts`
- `apps/orchestrator/src/lease-lifecycle.ts`
- `apps/orchestrator/src/runtime.ts`
- `apps/job-agent/src/bootstrap.ts`
- `images/jobs/linux-arm64/Containerfile`
- `.github/workflows/linux-arm64-container-smoke.yml`

Before exported symbol edits, use LSP references if available; otherwise enumerate exact consumers of `parseRunnerLabel|parseRunnerLabels|parseJobRunnerLabels|formatRunnerLabel|ParsedRunnerLabel` in `apps` and `packages`. Update full-job consumers without changing routing-only contracts.

## Verification after implementation

Run the focused suite:

```sh
bun test apps/control-plane/src/scheduler.test.ts apps/control-plane/src/reconcile.test.ts apps/control-plane/src/job-reconciler.test.ts apps/control-plane/src/lease-dispatch.test.ts apps/control-plane/src/workflow-pr.test.ts packages/db/src/job-label-recommendations.test.ts apps/orchestrator/src/linux-container.test.ts apps/orchestrator/src/windows-agent.test.ts apps/job-agent/src/bootstrap.test.ts
```

Cover case-insensitive parsing, duplicate/malformed/capability-only rejection, readiness across alternatives, optimization preserving capability and retry directives, focused-edit capability preservation, encrypted mode propagation, daemon startup failure, daemon loss, provisioning/restart cleanup. Add lifecycle failure tests with the helper.

Retain the ordinary job in `.github/workflows/linux-arm64-container-smoke.yml`; add a Docker-build job using `runs-on: [mars-ubuntu-arm64-container-2vcpu-4g, mars-docker-build]` and actual build/create/copy/run checks. Dispatch with only one verified host class eligible at a time. Identify the host from control-plane lease evidence, not guest `RUNNER_OS`. Verify JIT → encrypted bootstrap → private rootless startup → build/run → completion → outer removal; incapable workers must not reserve Docker-build requests, ordinary jobs must remain functional, and cancellation/restart must leave no daemon/build state. Passing tests alone is not acceptance.
