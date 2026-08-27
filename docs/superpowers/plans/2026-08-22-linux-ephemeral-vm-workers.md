# Ephemeral Linux VM Workers for Unraid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unsupported Linux K3s/Kata execution path with disposable libvirt-managed Ubuntu VM workers on Unraid.

**Architecture:** A persistent Linux VM broker registers with the control plane and owns libvirt operations. Each lease clones or resumes one signed Ubuntu 24.04 golden VM, injects one encrypted job bootstrap, waits for guest runner-ready and completion events, then destroys the VM and overlay disk. Suspended prewarm clones are an optional optimization; job runners never remain active between leases.

**Tech Stack:** Bun/TypeScript, PostgreSQL existing worker protocol, libvirt/virsh, QEMU/KVM, qcow2, cloud-init, Ubuntu 24.04, GitHub Actions JIT runners.

## Global Constraints

- Linux job isolation is the full VM boundary; K3s and Kata are not required for this path.
- The broker is persistent infrastructure, not a long-running job runner.
- Every VM is one-lease/one-job and is destroyed after terminal cleanup.
- Golden worker images are signed and immutable; clones use copy-on-write overlays.
- No Docker socket, host path, host credential, or reusable GitHub credential enters a job VM.
- GitHub runner registration is JIT/one-job and expires with the lease.
- Linux pool creation must fail closed until the broker and real VM smoke gate are ready.
- Local tests use injected libvirt and guest-protocol fakes; actual Unraid/libvirt/KVM proof is a required host gate.

## Current boundaries to preserve

- Worker enrollment and command transport remain the existing `WorkerCommand`/`WorkerEvent` WebSocket protocol.
- Lease bootstrap remains `LeaseBootstrapEnvelope` from `packages/contracts/src/orchestration.ts`.
- Existing macOS Tart and Windows Hyper-V/container drivers remain unchanged.
- Existing signed Linux appliance artifacts under `images/worker-appliance/` and `deploy/workers/install-worker.sh` are revised, not silently bypassed.

---

### Task 1: Define Linux VM runtime contracts

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/control-plane/src/lease-dispatch.ts`
- Modify: `apps/control-plane/src/lease-cleanup.ts`
- Test: `apps/control-plane/src/lease-dispatch.test.ts`

**Interfaces:**
- Add runtime driver name `linux-libvirt-vm`.
- Map `linux-libvirt-vm` to `linux-vm.create_lease` and cleanup to `linux-vm.stop_lease`.
- Preserve `LeaseBootstrapEnvelope` unchanged.

- [ ] Add failing tests for Linux VM command and cleanup mapping.
- [ ] Run `bun test apps/control-plane/src/lease-dispatch.test.ts`; confirm the new mapping fails.
- [ ] Implement the driver-name and command mappings.
- [ ] Add tests proving bootstrap ciphertext contains no plaintext JIT data.
- [ ] Run the focused dispatch/cleanup tests.
- [ ] Commit the contract boundary.

### Task 2: Implement injectable libvirt VM provider

**Files:**
- Create: `apps/orchestrator/src/libvirt-vm.ts`
- Test: `apps/orchestrator/src/libvirt-vm.test.ts`

**Interfaces:**
```ts
type VirshResult = { code: number; stdout: string; stderr: string };
type VirshRunner = (args: string[], stdin?: string) => Promise<VirshResult>;
type LinuxVmProviderConfig = {
  goldenDisk: string;
  goldenDigest: string;
  domainTemplate: string;
  cloneRoot: string;
  prefix: string;
  limits: WorkerLimits;
};
```

Produce `LibvirtVmProvider` with `validateHost`, `cloneLease`, `startLease`, `waitForGuestReady`, `sendBootstrap`, `waitForCompletion`, `stopLease`, `destroyLease`, and `reconcileOrphans`.

- [ ] Write failing tests for exact `virsh` calls and immutable golden-disk validation.
- [ ] Implement an injectable `VirshRunner`; no shell commands in tests.
- [ ] Clone a qcow2 overlay per lease with a unique domain name, UUID, MAC, and lease label.
- [ ] Define/start the domain from a rendered XML template and require KVM acceleration.
- [ ] Inject bootstrap through a one-use cloud-init/virtio channel; keep it out of argv and logs.
- [ ] Implement bounded guest-ready/completion waits and unconditional stop/destroy/overlay cleanup.
- [ ] Reconcile only `mars.managed=true` domains and never delete unknown VMs.
- [ ] Run `bun test apps/orchestrator/src/libvirt-vm.test.ts`.
- [ ] Commit the provider.

### Task 3: Add the Linux VM broker lifecycle

**Files:**
- Modify: `apps/orchestrator/src/linux-agent.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Create: `apps/orchestrator/src/linux-vm-broker.ts`
- Test: `apps/orchestrator/src/linux-agent.test.ts`
- Test: `apps/orchestrator/src/linux-vm-broker.test.ts`

**Interfaces:**
- `LinuxVmBroker` consumes `WorkerCommand` and emits existing `WorkerEvent` payloads.
- `linux-vm.create_lease` starts one VM, proxies guest-ready/runner-finished/reaped events, and rejects a second lease when capacity is exhausted.
- `linux-vm.stop_lease` is idempotent and destroys the matching VM.

- [ ] Add failing tests for create, completion, failure, duplicate lease, timeout, and cleanup paths.
- [ ] Implement broker lifecycle around `LibvirtVmProvider` and existing lease lifecycle event shapes.
- [ ] Add `linux-worker` entrypoint wiring in `apps/orchestrator/src/index.ts` with explicit required configuration.
- [ ] Preserve worker configure/reconnect/ack behavior and one broker identity.
- [ ] Run focused Linux broker tests.
- [ ] Commit the broker lifecycle.

### Task 4: Replace the K3s appliance with a libvirt worker appliance

**Files:**
- Modify: `images/worker-appliance/README.txt`
- Modify: `deploy/workers/install-worker.sh`
- Modify: `deploy/workers/worker-domain.xml`
- Create: `deploy/workers/worker-domain-template.xml`
- Test: `tests/installer-arguments.test.ts`
- Test: `tests/control-plane-image-smoke.sh` only if installer artifact paths change

**Interfaces:**
- Installer provisions a signed Ubuntu 24.04 golden disk and a persistent broker service on the Unraid/libvirt host.
- Domain template variables include golden disk, clone root, bridge/network, broker URL, and worker identity paths.

- [ ] Update appliance requirements from K3s/Kata to Ubuntu, QEMU/KVM, libvirt, cloud-init, Bun broker, and signed qcow2.
- [ ] Make installer preflight require `virsh`, `/dev/kvm`, x86_64, signed image bundle, and a usable libvirt network.
- [ ] Generate fresh broker identity and avoid reusing guest machine identity across clones.
- [ ] Register the broker as a service that survives host reboot without starting a job VM.
- [ ] Add a safe uninstall/upgrade path that preserves the golden image and removes only Mars-owned domains/overlays.
- [ ] Update installer contract tests for the new arguments and no K3s/Kata requirements.
- [ ] Run focused installer tests.
- [ ] Commit appliance and installer changes.

### Task 5: Enable Linux scheduling and onboarding only after readiness

**Files:**
- Modify: `apps/control-plane/src/default-pools.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/onboarding-routes.ts`
- Modify: `apps/control-plane/src/scheduler.ts`
- Modify: `apps/web/src/routes/OnboardingPage.tsx` if Linux readiness copy changes
- Test: `apps/control-plane/src/http/app.test.ts`
- Test: `apps/control-plane/src/onboarding.test.ts`
- Test: `apps/control-plane/src/scheduler.test.ts`

**Interfaces:**
- Linux workers report `platform=linux-x64`, `guestPlatforms=[linux-x64]`, and broker runtime readiness.
- Linux pool driver is `linux-libvirt-vm`.
- Pool creation remains rejected until broker doctor/runtime readiness and golden-image verification are true.

- [ ] Add failing tests proving Linux pool creation is rejected before broker readiness.
- [ ] Replace `kata-k3s` selection with `linux-libvirt-vm` for Linux workers.
- [ ] Preserve aggregate CPU/memory/storage/concurrency admission checks.
- [ ] Remove stale user-facing `Linux runners are not available` messages once the broker contract is active.
- [ ] Add tests for ready Linux pool creation and lease dispatch type.
- [ ] Run control-plane focused tests.
- [ ] Commit scheduler/onboarding integration.

### Task 6: Add real guest one-job runner protocol

**Files:**
- Modify: `apps/job-agent/src/index.ts`
- Modify: `apps/job-agent/src/bootstrap.ts`
- Create: `apps/job-agent/src/linux-guest.ts`
- Test: `apps/job-agent/src/bootstrap.test.ts`
- Test: `apps/job-agent/src/linux-guest.test.ts`

**Interfaces:**
- Guest consumes exactly one `LeaseBootstrapEnvelope` from the injected channel.
- Guest emits runner-ready, job completion, bounded logs/diagnostics, and exit status through the broker channel.
- Guest deletes bootstrap material and exits after one job.

- [ ] Add failing tests for one-use bootstrap consumption, expiry, secret redaction, and second-job rejection.
- [ ] Implement Linux guest startup and broker event protocol.
- [ ] Use JIT runner registration; do not persist GitHub registration tokens.
- [ ] Ensure shutdown on completion, timeout, broker disconnect, and cancellation.
- [ ] Run focused job-agent tests.
- [ ] Commit guest runtime changes.

### Task 7: Build local fake-host integration and Unraid acceptance smoke

**Files:**
- Create: `apps/orchestrator/src/libvirt-vm.integration.test.ts`
- Create: `tests/linux-libvirt-worker-smoke.sh`
- Modify: `IMPLEMENTATION-STATUS.md`
- Modify: `deploy/control-plane/README.md`

**Interfaces:**
- Fake-host integration exercises the complete broker/guest lifecycle without libvirt.
- Real smoke runs only when `MARS_LINUX_VM_E2E=1` and requires Unraid/libvirt/KVM, a signed golden disk, a deployed control plane, and a disposable GitHub repository.

- [ ] Add fake end-to-end test: provision, ready, run one job, complete, destroy, reconcile.
- [ ] Add failure tests for stale domains, missing overlays, guest timeout, and broker restart.
- [ ] Document Unraid VM template creation, bridge networking, storage path, prewarm clone count, and rollback.
- [ ] Add the real smoke script with bounded cleanup and no deletion of unowned VMs.
- [ ] Mark Linux execution production-ready only after the real smoke passes; otherwise retain the explicit limitation.
- [ ] Run all focused suites and typecheck.
- [ ] Commit the acceptance gate and documentation.

## Verification

- `bun test apps/orchestrator/src/libvirt-vm.test.ts apps/orchestrator/src/linux-vm-broker.test.ts apps/job-agent/src/linux-guest.test.ts apps/control-plane/src/lease-dispatch.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/scheduler.test.ts`
- `bun run typecheck`
- `bun run build`
- `MARS_LINUX_VM_E2E=1 bash tests/linux-libvirt-worker-smoke.sh` on an Unraid/libvirt host.
- Acceptance requires a real one-job VM clone, runner completion, VM destruction, overlay deletion, and orphan reconciliation.
