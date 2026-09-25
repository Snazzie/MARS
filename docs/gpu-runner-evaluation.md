# GPU runners: evaluation and deferred design

## Decision

Defer GPU-enabled MARS runners until an actual CI workload needs a GPU **inside the job**. Many applications call an external inference or training service; those jobs need network access and credentials, not a GPU on the runner. Adding local GPU support before end-to-end GitHub Actions job execution is reliable would introduce a second execution path without a demonstrated need (see [implementation status](../IMPLEMENTATION-STATUS.md)).

Revisit when a team has a concrete workflow that cannot run on CPU or against a hosted service, a dedicated compatible Linux x64 NVIDIA host, and a reason to test on specific hardware. Examples include CUDA/kernel tests, self-hosted inference containers, graphics/rendering tests, and hardware-specific performance checks. Managed GPU services may still be a better place for long-running training; CI can build and submit those workloads without owning the GPU.

## If demand is proven

Prove a narrow path first: one dedicated Linux x64 Docker GPU worker, one operator-approved physical GPU, one GPU job at a time, a real GitHub Actions job that sees only its assigned device, and crash/restart cleanup before another lease receives that device. Do not use `--gpus all` for job containers. Exclusive MARS lease allocation prevents two MARS jobs sharing a card; it does **not** isolate performance from host processes, thermal limits, or other operators using the host. Reliable benchmarks require a dedicated, controlled host.

The proposed workflow label syntax places GPU selection **after** the existing CPU and memory request:

```yaml
runs-on: mars-ubuntu-24-4vcpu-16g-rtx5090gpu
```

`rtx5090` would be an operator-approved exact-model shortform, not a fuzzy match against a driver-reported marketing name. Operators could optionally classify detected, approved cards into groups, allowing labels such as:

```yaml
runs-on: mars-ubuntu-24-4vcpu-16g-smallgpu
```

Group names and membership would be explicitly managed in the UI, not inferred solely from VRAM or generation. One GPU could belong to several groups, but its physical UUID could be leased to only one job at a time. A missing matching card would leave the GPU job queued rather than silently substituting another model or CPU. Existing composite labels currently end at `-<memory>g`; **these GPU suffixes and GPU groups are proposals, not implemented functionality** (see [worker routing labels](worker-routing-labels.md)).

## Reassessment criteria

1. Normal MARS runners complete and clean up real GitHub Actions jobs reliably.
2. A named workload demonstrably needs GPU compute in its CI job rather than access to an external GPU-backed service.
3. The hardware, driver/toolkit upkeep, isolation limitations, and idle capacity cost are justified by faster feedback or required hardware-compatibility coverage.

If those conditions are not met, retain CPU runners and run GPU-heavy work on the appropriate external service.
