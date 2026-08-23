# Worker Cache and Health Observability Design

## Goal

Improve `/workers` so an operator can diagnose worker health without correlating separate timestamps and lease records manually. The primary use case is cache-health diagnosis, extended with current jobs and system usage.

## Scope

Add an expandable **Live health** section to each existing `WorkerCard`. It contains three independently readable areas:

- **System usage:** actual, reserved, and free CPU, memory, storage, and pods, with observation age.
- **Cache health:** desired/effective TTL, readiness, snapshot generation, entry count, size, proxy status, last observation, and error/remediation.
- **Running jobs:** active leases joined to dashboard job and repository metadata when available.

Keep worker configuration, adoption, drain, and image-build flows unchanged.

## API

Add an authenticated read-only endpoint:

```text
GET /api/workers/:workerId/health
```

Authorization matches existing global-admin worker/cache endpoints.

Response:

```ts
{
  observedAt: string | null,
  connection: {
    state: "online" | "offline",
    lastHeartbeatAt: string | null,
    lastDoctorAt: string | null,
    heartbeatAgeSeconds: number | null,
    doctorAgeSeconds: number | null
  },
  usage: {
    cpu: { actual: number, reserved: number, free: number },
    memoryBytes: { actual: string, reserved: string, free: string },
    storageBytes: { actual: string, reserved: string, free: string },
    pods: { actual: number, reserved: number, free: number }
  },
  cache: {
    desiredTtlSeconds: number,
    effectiveTtlSeconds: number | null,
    ready: boolean,
    generation: string | null,
    sizeBytes: string,
    entryCount: number,
    observedAt: string | null,
    error: string | null
  },
  jobs: Array<{
    jobId: number | null,
    repositoryFullName: string | null,
    name: string | null,
    leaseId: string,
    state: string,
    startedAt: string | null,
    ageSeconds: number | null,
    requested: {
      vcpu: number,
      memoryBytes: string,
      storageBytes: string,
      concurrency: number
    }
  }>
}
```

Contract rules:

- `jobs` includes only active lease states.
- Missing GitHub metadata does not hide a lease.
- Byte counts remain decimal strings.
- Stale or absent telemetry returns `200` with null/age fields, not an HTTP error.
- Unknown workers return `404`.
- Never expose credentials, authenticated proxy URLs, cache keys, signed URLs, or certificates.

## Data sources

- Connection and heartbeat timestamps: `workers`.
- System doctor/capacity: `workers.doctor`.
- Desired/effective cache state: worker configuration plus `worker_cache_status`.
- Current jobs: active `runner_leases`, left joined to dashboard jobs, runs, and repositories.
- Connection state: control-plane authenticated socket map, not persisted `workers.connection_state`.

## UI behavior

- Live health is collapsed by default.
- Expanding starts health polling; collapsing stops polling after the in-flight request.
- Health polling is independent of the slower worker configuration query.
- Each subsection has independent loading and error states.
- Show explicit stale badges when heartbeat, doctor, or cache observation exceeds its freshness threshold.
- Preserve job rows during temporary cache/doctor failures because leases are authoritative for active work.
- Empty states distinguish no active jobs, no cache snapshot, unavailable telemetry, and offline worker.
- Show usage as actual / reserved / free to avoid confusing free capacity with utilization.

## Accessibility

- Use headings and section landmarks.
- Expand controls expose `aria-expanded` and `aria-controls`.
- Status is conveyed with text in addition to color.
- Jobs and inventory use captions and stable table headers.
- Timestamps use `<time dateTime>`.
- Loading uses `role="status"`; errors use `role="alert"`.

## Verification

Backend tests:

- Health response contract parsing.
- Active lease join with and without GitHub metadata.
- Stale and missing telemetry.
- Decimal byte preservation.
- Authorization, `404`, and secret omission.

Frontend tests:

- Collapsed and expanded health states.
- Polling starts/stops with expansion.
- Independent loading/error states.
- Stale indicators.
- Empty jobs/cache states.
- Rendering large byte values without precision loss.

Browser smoke verification:

1. Open `/workers` with an adopted worker.
2. Expand Live health.
3. Confirm usage, cache, and current jobs render.
4. Confirm refresh updates timestamps/job states.
5. Confirm stale/offline and partial-error states remain understandable.
