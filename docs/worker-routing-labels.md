# Worker Resource Labels

Use runner labels to request CPU and memory for an individual job.

## Labels

Add these labels alongside the worker pool trigger label:

| Label | Meaning | Example |
| --- | --- | --- |
| `Nvcpu` | Request exactly `N` vCPUs | `3VCPU` requests 3 vCPUs |
| `Ng` | Request exactly `N` GiB of memory | `6g` requests 6 GiB (`6442450944` bytes) |

The suffixes are case-insensitive. Values must be positive whole numbers, so `2vcpu`, `3VCPU`, and `6G` are valid.

Example label set:

```text
whitesmith-linux-x64, 3VCPU, 6G
```

This requests a job with 3 vCPUs and 6 GiB of memory from the `whitesmith-linux-x64` pool.

## How routing works

1. The control plane removes valid CPU and memory resource labels before matching pool labels.
2. Remaining labels, including the pool trigger label, must match the selected pool.
3. If a CPU or memory label is omitted, the pool's configured value is used.
4. The worker's configured per-job limits are the final ceiling.
5. The original labels are retained when the just-in-time GitHub runner is registered.

A valid label may exceed the pool's default CPU or memory value when the worker's configured limit allows it. Per-job limits are independent ceilings; the scheduler does not reserve the full per-job limit for every concurrency slot. It admits each queued job only when the resolved request fits currently available resources. Storage and concurrency continue to use the existing pool and worker policies; there is no disk resource-label syntax.

## Invalid labels

The job remains unroutable when resource labels are invalid or conflicting. Examples:

- `0vcpu` or `0g`
- `01vcpu`
- Two CPU labels, such as `2vcpu, 3vcpu`
- Two memory labels, such as `4g, 6g`
- Values larger than the safe numeric range
- Malformed resource candidates

Labels such as `6gb` are not memory resource labels. They are ordinary routing labels and must be explicitly present on the pool.

## Worker limits

Resource labels cannot bypass worker policy. For example, a worker with a maximum of 4 vCPUs per job accepts `3VCPU` but does not accept `5vcpu`. The same per-job ceiling applies to memory and storage. `maxConcurrentPods` limits the number of active jobs; it is not multiplied by the per-job CPU, memory, or storage ceilings during configuration. Reservations re-check resource and concurrency limits atomically immediately before work is assigned.
