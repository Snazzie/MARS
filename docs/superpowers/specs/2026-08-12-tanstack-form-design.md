# TanStack Form Migration Design

## Goal

Adopt TanStack Form across Mars data-entry forms while preserving existing API contracts and server-derived onboarding progression. Improve validation UX with blur/submit validation, field-level errors, cross-field errors, first-invalid focus, dirty state, and reliable mutation state.

## Scope

Migrate:

- `WorkerConfigurationForm`
- onboarding GitHub organization selection and repository approval
- onboarding pool/trigger-label creation
- organization settings

Keep outside TanStack Form:

- repository search and visibility filters
- confirmation-only dialogs
- read-only wizard summaries and server polling

## Architecture

Add `@tanstack/react-form` and one shared Mars form-hook module built with `createFormHook`. The module registers typed reusable controls for text, integer/number, select, checkbox groups, field errors, form errors, and submit buttons.

TanStack Form owns values, touched/dirty state, validation state, submission state, and first-invalid focus. TanStack Query remains responsible for network mutations, cache invalidation, and server-derived onboarding detail. Existing API functions and payload contracts remain unchanged.

Use existing Zod contracts where they represent API payloads. Add local UI-shape schemas where inputs differ from transport shape, such as GiB strings/numbers mapped to byte fields. Validate the mapped payload with the existing shared contract before invoking a mutation.

## Validation and interaction

- Untouched fields show no validation message.
- Blur validates the field and reveals its field-level message.
- Submit validates all fields, shows all relevant messages, and focuses the first invalid control.
- Cross-field constraints return a form-level error and identify affected fields when possible.
- API/mutation errors render at form level and clear on the next submit attempt; arbitrary typing does not hide a server error.
- Submit controls reflect invalid, unchanged, pending, and success states appropriate to each form.
- Onboarding forms reset only when the selected worker, organization, or resource identity changes. Server refreshes do not erase user edits for the same identity.
- Existing `Idempotency-Key` generation and mutation routes remain mandatory.

## Form-specific rules

### Worker resources

Keep the transport payload `{ organizationId, appliance, runtime }`. The UI accepts integer GiB values and maps them to safe byte values. Reject non-integers, non-positive values, unsafe conversions, per-job ceilings above appliance ceilings, and ceiling-times-concurrency above appliance capacity before mutation. Preserve the server's `202` and exact configuration-revision acknowledgement flow.

### GitHub repositories

The organization selection remains a controlled form field. Repository approval requires at least one available private/internal repository. Public, unavailable, cross-organization, pending, and suspended installation records remain rejected by the server. Batch approval keeps the existing endpoint and idempotency behavior.

### Trigger labels and pool creation

Validate pool name, immutable image digest, resources, and the canonical custom trigger-label schema. Reject reserved labels and duplicate names/labels through the existing server contract. Render effective labels and the `runs-on` example from server/platform data; do not duplicate server scheduling logic in the form.

### Organization settings

Replace manual submit parsing with TanStack Form state and validation while preserving the existing settings endpoint, idempotency key, query invalidation, and server error semantics.

## Testing

Add or update focused tests for:

- valid form-to-payload mapping
- GiB overflow, non-integer, and non-positive values
- resource ceilings and concurrency cross-field validation
- required private/internal repository selection
- trigger-label schema and reserved-label errors
- touched/dirty/reset behavior
- first-invalid focus and submit validation
- pending/disabled submit state
- mutation/API error rendering and retry
- unchanged API payloads and existing server contracts

Browser verification must exercise the worker resource, repository approval, pool/trigger-label, and organization-settings forms without console errors or accidental mutation retries.

## Non-goals

- No replacement of TanStack Query.
- No migration of search/filter controls.
- No API or database contract changes.
- No redesign of the onboarding state machine.
- No automatic resource defaults that conceal insufficient worker capacity.
