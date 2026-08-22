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

## Control-plane hosting readiness

- The PostgreSQL-only Linux/amd64 control-plane image and Compose contract require only `DATABASE_URL`; persistent setup data lives in PostgreSQL plus the named data volume.
- The first-run gate persists the canonical public origin, generates durable encryption material in `DATA_ROOT`, and collects GitHub App credentials through onboarding.
- CI validates the image artifact set and live/readiness endpoints; release metadata records the Linux/amd64 image digest, SBOM, and provenance.
- This proves control-plane hosting and the first-run gate only. Worker execution, GitHub workflow dispatch, and end-to-end runtime gates remain incomplete and the platform is not production-ready.

## Database ownership

- Drizzle ORM owns the PostgreSQL runtime client, generated schema, relations, and checked-in migrations.
- Existing query modules execute through the Drizzle-backed database client while preserving their SQL semantics and result contracts.
- The custom `schema_migrations` runner has been removed; existing installations are adopted by seeding the Drizzle baseline metadata before applying newer migrations.
