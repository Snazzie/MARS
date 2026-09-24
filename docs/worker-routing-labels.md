# Worker Resource Labels

Runner labels carry both the route and the resources for one scheduling option. Every
requested option must use the composite form:

```text
<route>-<vcpu>vcpu-<memoryGiB>g
```

The route may be `mars-any`, `mars-any-x64`, or a pool trigger route such as
`mars-windows-x64` or `mars-ubuntu-24`. Ubuntu x64 routes include the image's
major version: `mars-ubuntu-22`, `mars-ubuntu-24`, or `mars-ubuntu-26`.
The bundled Linux x64 golden image is Ubuntu 24; deployments using an Ubuntu 22
or 26 golden image must set both `DEFAULT_JOB_UBUNTU_VERSION` and
`DEFAULT_JOB_IMAGE_LINUX_X64` to that image's version and digest. A versioned
route matches only a pool with the same trigger; requesting 26 never runs on a
24 or 22 image. CPU and memory are required positive safe integers, and the
suffixes are case-insensitive. For example:

```yaml
runs-on: mars-any-4vcpu-10g
```

requests 4 vCPUs and 10 GiB (`10737418240` bytes). Standalone resource labels
such as `4vcpu` or `10g` are invalid and are not combined with a route label.

## Alternatives

A workflow may provide several composite labels as OR alternatives. Mars chooses
one option before creating the ephemeral runner; GitHub then schedules the job on
that runner. Each option owns its own CPU and memory request, so alternatives can
match different platforms with different limits:

```yaml
runs-on:
  - mars-windows-x64-4vcpu-20g
  - mars-windows-arm64-4vcpu-20g
  - mars-macos-arm64-4vcpu-10g
  - mars-ubuntu-24-4vcpu-10g
```

The exact pool trigger route wins when it matches a pool. Otherwise
`mars-any-x64` matches only pools whose platform ends in `-x64`, and `mars-any`
matches every platform. This precedence is independent of the order of labels in
the workflow. `mars-windows-arm64` is accepted as a route and preserved by
workflow editing, but no Windows ARM64 worker pool is currently available, so
that alternative cannot be selected today.

## How routing works

1. Mars parses the complete requested label set and rejects blank, malformed, or
   duplicate alternatives.
2. The scheduler selects the most specific matching alternative for each eligible
   pool: exact trigger, then `mars-any-x64`, then `mars-any`.
3. The selected option's vCPU and memory are checked against the worker's per-job
   ceilings. Mars never fills in missing resource values from pool defaults.
4. Storage and concurrency continue to come from the selected pool and existing
   worker policies; there is no disk resource-label syntax.
5. The original complete label array is retained when the just-in-time GitHub
   runner is registered.

A valid request may exceed a pool's configured defaults when the worker's limits
allow it. Reservations re-check resource and concurrency limits atomically before
work is assigned. The worker appliance capacity remains the aggregate maximum
CPU, memory, and storage Mars may use at one time.

## Invalid labels

The job remains unroutable when any requested option is invalid or conflicting.
Examples include:

- standalone `4vcpu` or `10g` labels;
- omitted CPU or memory suffixes, such as `mars-linux-x64`;
- zero, fractional, or unsafe values;
- malformed routes or resource suffixes;
- duplicate full labels, even with different casing;
- duplicate routes with different resource requests;
- mixing composite labels with legacy split labels such as `self-hosted`,
  `windows`, `x64`, or `mars-default`.

Use one complete composite label for a single-platform job, for example:

```yaml
runs-on: mars-windows-x64-4vcpu-6g
```

For a macOS ARM64 job using the current default resources:

```yaml
runs-on: mars-macos-arm64-2vcpu-4g
```

## Worker limits

Composite labels cannot bypass worker policy. A worker with a maximum of 4 vCPUs
per job accepts `mars-windows-x64-4vcpu-6g` but not an otherwise valid request for
more than 4 vCPUs. The same per-job ceiling applies to memory and storage.
`maxConcurrentPods` limits active jobs; it is not multiplied by per-job resource
ceilings during configuration.
