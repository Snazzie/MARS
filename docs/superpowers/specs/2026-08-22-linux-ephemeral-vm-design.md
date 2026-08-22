# Ephemeral Linux VM Workers on Unraid

## Goal

Run one GitHub Actions job per disposable Ubuntu VM on Unraid, using libvirt clones from a signed golden worker image. Keep the control plane and a lightweight VM broker persistent; never keep job runners alive between jobs.

## Decision

Use full libvirt-managed Ubuntu VMs instead of K3s/Kata for the first Linux production path. The VM is the isolation boundary. The guest contains the Whitesmith job agent and GitHub runner prerequisites; the Unraid host does not expose its Docker socket or host filesystem to jobs.

## Architecture

```text
Control plane + PostgreSQL + cloudflared
                 |
          worker protocol
                 |
       Linux VM broker on Unraid
          /       |       \
  clone/resume  clone/resume  clone/resume
       Ubuntu job VM per lease
```

The broker is a persistent control process, not a runner. It advertises clone capacity, creates a uniquely named libvirt VM for each lease, injects the encrypted lease bootstrap through a one-use cloud-init/virtio channel, proxies guest lifecycle events, and destroys the VM and overlay disk after completion.

The golden image is a signed Ubuntu 24.04 x86_64 qcow2 containing the guest agent, runner dependencies, cloud-init, and no reusable GitHub credentials. Every clone receives a fresh VM UUID, MAC address, hostname, machine identity, and Whitesmith lease identity. Suspended prewarm clones are optional optimization; they are not active workers.

## Lifecycle

1. Broker validates KVM/libvirt, golden image signature, storage headroom, and bridge networking.
2. Scheduler dispatches one Linux lease to the broker.
3. Broker creates a copy-on-write clone with a lease label and starts it.
4. Guest bootstraps, connects through the control-plane tunnel, and emits runner-ready.
5. Guest executes exactly one JIT GitHub job.
6. Guest reports exit/result and bounded diagnostics.
7. Broker stops and undefines the VM, deletes the overlay and transient bootstrap material, and reports lease reaped.
8. Broker reconciles orphaned `whitesmith` VMs after restart before accepting new leases.

## Security invariants

- No Docker socket, host path, privileged host device, or reusable GitHub credential enters a job VM.
- VM disks are copy-on-write overlays backed by a read-only signed golden image.
- Lease bootstrap is encrypted, one-use, bounded, and removed on every terminal path.
- Guest runner registration is JIT/one-job, not a persistent GitHub runner.
- Host-side libvirt access is limited to the broker service account and required VM operations.
- Mutable images and unsigned golden artifacts fail closed.

## Scope boundary

The first implementation runs the runner directly inside the VM. Nested Docker-in-Docker for workflows that themselves require Docker is a separate capability and must not block the base Linux runner path.

## Acceptance

A Linux pool is schedulable only after a real Unraid broker proves: clone/start, guest enrollment, runner-ready, one real GitHub job, result delivery, VM destroy, overlay deletion, and orphan reconciliation. Local development uses an injected libvirt runner and fake guest protocol; Unraid/Linux is required for the final host gate and startup measurement.
