# Whitesmith Implementation Status

The repository is a working baseline, not the full approved platform.

## Highest priority: real job execution

- Implement GitHub `workflow_job` webhook dispatch and durable outbox.
- Implement lease state machine, FIFO/round-robin scheduling, retries, and reconciliation.
- Replace the in-memory Kata driver stub in `apps/orchestrator/src/kata-k3s.ts` with real K3s/Kata Pod, PVC/block-volume, attestation, claim handoff, and cleanup.
- Expand `apps/job-agent` from claim hashing to real job-agent WebSocket/JIT exchange and runner lifecycle.

## Linux appliance

- Build/sign the Ubuntu 24.04 appliance image.
- Install and configure K3s, containerd, Kata runtime-rs, QEMU, CNI, Bun agent, and doctor.
- Complete signed libvirt import, NoCloud seed handling, firstboot join, secure cleanup, and removal.

## GitHub integration

- Implement GitHub App Manifest creation/install/approval/suspension.
- Add organization/repository/membership persistence and authorization.
- Add JIT runner registration and automated runner removal.
- Add webhook transition handling, job logs, retention, and search.

## Windows and macOS production paths

- Windows: implement real Hyper-V worker enrollment, isolated job containers, VHDX lifecycle, and claim injection.
- macOS: Tart enrollment/connectivity and the manually registered smoke runner work. A `TartVmDriver` now clones, sizes, starts, stops, and deletes one VM per lease, and the worker handles lifecycle commands. Remaining work is control-plane dispatch, PTY job-agent claim handoff, exact read-back attestation, cleanup reconciliation, and LaunchDaemon packaging.

## Dashboard/API

- Add setup wizard and installation flow.
- Add pools, repositories, jobs, logs, images, settings, drain/remove/key rotation.
- Add charts, lifecycle details, pagination, tenant isolation, browser WebSocket invalidation, and error/security states.

## Worker routing label pattern

Worker pool trigger labels remain ordinary routing labels. Optional per-job resource labels use positive decimal integers with these case-insensitive suffixes:

- `Nvcpu` sets the exact vCPU request, for example `2vcpu` or `3VCPU`.
- `Ng` sets the exact memory request in GiB, for example `6g` = `6442450944` bytes.

The parser removes valid resource labels before pool-label matching, then carries the original labels into JIT runner registration. CPU and memory dimensions omitted from the job use the pool defaults. Storage and concurrency retain their existing pool behavior. Duplicate dimensions, zero, non-canonical values such as `01vcpu`, overflow, or malformed resource candidates are rejected; unrelated labels such as `6gb` still require a matching pool label. Worker per-job limits are the final ceiling, including when a valid CPU or memory label exceeds the pool default.

## Verification/release

- Add end-to-end PostgreSQL/GitHub/Kata/libvirt/Hyper-V/Tart fixtures.
- Add crash/replay/reconciliation tests.
- Add secret persistence scans and protocol compatibility tests.
- Produce signed multi-architecture OCI images, appliance artifacts, SBOMs, provenance, and CI release gates.

## Current evidence

- `apps/orchestrator/src/kata-k3s.ts`: `createLease()` creates an in-memory UUID rather than a Pod.
- `apps/job-agent/src/index.ts`: only accepts and hashes a claim.
- `apps/control-plane/src/github.ts`: OAuth helpers exist; GitHub App lifecycle is not complete.
- `apps/orchestrator/src/tart.ts`: real Tart command lifecycle is implemented behind an injectable runtime; current tests use a fake runtime and do not create a 20+ GiB VM.
