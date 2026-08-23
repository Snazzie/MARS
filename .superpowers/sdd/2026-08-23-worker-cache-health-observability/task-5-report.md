# Task 5 Report: Expandable WorkerCard health UI

## Files

- `apps/web/src/components/WorkerHealthPanel.tsx` — new accessible usage, cache, and running-jobs panel with loading/error/empty/stale states and decimal byte-safe rendering.
- `apps/web/src/components/WorkerHealthPanel.test.tsx` — component coverage for rendering, large decimal bytes, stale/offline/empty/partial-error states, and loading/error semantics.
- `apps/web/src/components/WorkerCard.tsx` — collapsed-by-default Show/Hide live health control and lazy health query/panel integration.
- `apps/web/src/components/WorkerCard.test.tsx` — collapsed and expanded accessibility/lazy-query coverage while retaining existing behavior coverage.
- `apps/web/src/styles.css` — focused dark dashboard styles for health panel metrics, status badges, errors, and jobs table.

## Commit

Implementation commit: `87f281a` (`feat(web): add worker health panel`)

## Verification

### RED

Focused command before implementation:

```text
bun test apps/web/src/components/WorkerCard.test.tsx apps/web/src/components/WorkerHealthPanel.test.tsx
12 pass
2 fail
```

Failures were the expected missing `WorkerHealthPanel.tsx` module and absent collapsed WorkerCard `aria-expanded` contract.

### GREEN

Focused command after implementation:

```text
bun test apps/web/src/components/WorkerCard.test.tsx apps/web/src/components/WorkerHealthPanel.test.tsx
19 pass
0 fail
67 expect() calls
```

Per the brief, formatters, linters, and project-wide suites were not run.

## Concerns

- The `WorkerHealth` DTO exposes cache `observedAt` but no cache age-seconds field; the panel marks cache stale when an observed snapshot exists while cache readiness is false, while heartbeat/doctor stale badges use their server age fields.
- Existing unrelated working-tree changes were left untouched.
