# Inline Worker Enrollment Design

## Goal

Replace modal worker enrollment with a single inline flow on both first-run onboarding and the Workers page. The onboarding Worker step must reliably show connected pending workers, require explicit identity selection, and never claim a worker was selected before the server records that selection.

## Decision

Make a clean global cutover from `EnrollmentWizard` to an inline `EnrollmentPanel`. Do not retain a modal mode or duplicate enrollment implementations.

## Placement

### Onboarding Worker step

Render, in order:

1. Inline enrollment controls.
2. The generated one-use installer command or connected success state.
3. Pending worker cards with explicit **Use this worker** actions.

A connected worker remains unschedulable and onboarding does not advance until the administrator selects its card.

### Workers page

Render the same inline enrollment panel below the page header and above pending and active worker sections. The panel may be used repeatedly to enroll additional workers.

## State and data flow

The owning page creates one pending-worker query and passes its current data and refetch action to the panel. The panel does not create a second independent pending-worker query.

On mount, the panel loads bootstrap status and available control-plane URLs. Before generating or rotating a bootstrap code, it snapshots pending worker IDs and connection states. After revealing a code, polling recognizes success only when either:

- a new pending worker appears online, or
- a worker that was offline in the snapshot transitions online.

An unrelated worker that was already online cannot complete a new enrollment attempt.

When the matching worker connects, the panel:

- removes the one-use command from view,
- shows a concise **Worker connected** state,
- invokes the page refresh callback, and
- preserves the explicit **Use this worker** security decision.

**Enroll another worker** resets the panel. If a bootstrap credential already exists, generating another code uses the existing rotation confirmation.

## Truthful onboarding progress

The completed-step review renders worker completion only when `OnboardingDetail.worker` is non-null, which reflects a persisted `system_onboarding.worker_id`. Remove the fallback `Worker: Selected` label. While the Worker step is current and no worker is selected, the review does not claim completion.

## Errors

Bootstrap status, URL, code-generation, and pending-worker failures render inline near their controls. Pending-worker failures show the actual `ApiRequestError` message when available and provide Retry. A failed query does not erase a previously loaded worker list.

## Component boundaries

- `EnrollmentPanel`: bootstrap status, platform and URL inputs, code generation/rotation, installer command, connection correlation, success/reset state.
- Onboarding `WorkerStep`: owns the pending-worker query, renders the panel and worker choices, and invokes selection.
- `WorkersPage`: owns the pending-worker query and passes it to both `EnrollmentPanel` and `PendingWorkerRequests`.

Remove dialog refs, `showModal`, close/cancel handling, modal-only helpers, and modal-only styles.

## Verification

Tests cover:

- enrollment controls rendered inline with no `<dialog>`,
- inline placement on onboarding and Workers pages,
- status and URL loading without an open action,
- installer command generation,
- connection correlation against the enrollment snapshot,
- connected success state and command removal,
- explicit **Use this worker** remaining required,
- actual API error and Retry rendering,
- no completed worker summary when no worker is selected,
- selected worker summary after persisted selection,
- rotation confirmation for additional enrollment.

Browser verification exercises the actual onboarding Worker step: generate/reveal state, connected worker appearance, explicit selection, and transition to the next server-owned onboarding step.
