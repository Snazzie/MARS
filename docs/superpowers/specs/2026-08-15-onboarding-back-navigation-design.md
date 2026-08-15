# Editable Onboarding Back Navigation

## Goal

Allow administrators to revisit completed onboarding steps, edit their existing values, and save corrections without clearing later selections.

## User experience

- Progress items before the current server step are keyboard-accessible buttons.
- Selecting a completed step opens that step's existing editable form with server-persisted values prefilled.
- Cancel/close returns to the current step without changing data.
- Save uses the existing API mutation for that step, then returns to the current step and refreshes onboarding data.
- Later selections remain unchanged. No automatic reset or cascade occurs.
- If a changed earlier value conflicts with a later configuration, the server/API validation error is shown; the UI does not silently delete later data.

## Architecture

`OnboardingPage` retains the server-derived current step as the source of truth. It adds a local `editingStep` state used only to render an editable overlay. Existing forms and API mutations remain the persistence boundary. The existing read-only completed-step summary becomes an editable-step launcher/overlay rather than a source of duplicated form state.

Editable steps:

- Worker: worker selection and resource configuration forms, using pending worker data and existing worker-selection/configuration APIs.
- GitHub: organization selection and app installation/manifest actions, with existing detail values prefilled.
- Trigger labels: pool name, trigger label, guest platform, image, and resources, using the existing onboarding pool submission path. The implementation must update the existing onboarding pool when its identity matches; it must not create a second pool for an edit.

The overlay must not advance or rewind the server onboarding step. After a successful save, invalidate onboarding and pending-worker queries and close the overlay.

## Error handling

- Preserve form state on failed requests.
- Display API errors in the active editable form.
- Keep the user in the selected edit overlay until cancel or successful save.
- Do not mutate later configuration on cancellation or validation failure.

## Accessibility

- Completed progress items use real buttons with visible labels.
- The edit surface uses a dialog or equivalent labelled region, supports Escape/cancel, and returns focus to the originating step button.
- Current and future steps remain distinguishable from editable completed steps.

## Verification

Add component tests covering: completed-step buttons, prefilled editable content, cancel without mutation, successful save/refetch, and preservation of later summary data. Run the focused onboarding and web typecheck tests, then exercise the onboarding page in the browser.
