# Mars Sign-in and Onboarding Wizard UI

## Goal

Replace the current bare onboarding markup with a proper GitHub sign-in screen and a resumable, server-gated setup wizard. The flow must remain safe to refresh, understandable to operators, and consistent with the existing dark Mars console visual language.

## Sign-in

`OnboardingPage` renders a focused centered card before authentication.

- No setup detail is fetched or rendered until the public status reports an authenticated global administrator.
- When `adminCreated=false`, heading is `Create your administrator account`; otherwise it is `Sign in to Mars`.
- The primary action links to `/api/auth/github` and is labeled `Continue with GitHub`.
- The card explains that GitHub supplies identity and organization access; Mars stores no password.
- Include a security note that only the configured GitHub account can administer the instance.
- Loading, API failure, and return-from-OAuth states are explicit and accessible.
- An authenticated non-admin sees an administrator-required terminal state with a retry/sign-out affordance, without setup data.

## Wizard layout

For authenticated global administrators with incomplete onboarding, render a two-column layout.

### Step rail

The left rail contains:

1. Admin
2. Worker
3. GitHub
4. Resources
5. Trigger labels

The current server-derived step is highlighted. Completed steps are selectable for read-only review. Future steps are visibly locked and cannot be mutated. A persistent status line communicates `Saved automatically` or a relevant wait state such as `Waiting for worker`.

### Main panel

The right panel contains one focused task card:

- step number and title;
- concise purpose and prerequisite copy;
- current step content and mutation controls;
- one visually dominant primary action;
- inline errors with retry;
- accessible live status for asynchronous worker/configuration acknowledgement.

The client never advances the step locally. Refresh and back navigation refetch server state. Server-derived state remains authoritative. Review mode may inspect completed steps but does not expose mutation controls.

## Step content

- **Worker:** embed enrollment/bootstrap controls, poll pending workers only while relevant, display platform/fingerprint/capacity, and require explicit worker selection.
- **GitHub:** show organization/install status, then available private/internal repositories only; support explicit batch approval.
- **Resources:** reuse `WorkerConfigurationForm`; show submitted/configuring/acknowledged states and poll until exact configuration revision acknowledgement.
- **Trigger labels:** show pool name, custom label, immutable image digest, effective labels, and copyable `runs-on` example; pool creation remains server validated.
- **Complete:** show selected organization, approved repository count, ready worker, pool, effective labels, workflow example, and `Open dashboard`.

## Visual system

Use the existing dark console tokens and typography. Add onboarding-specific styles rather than changing dashboard layout globally:

- centered sign-in surface with restrained panel contrast;
- spacious wizard grid with clear rail/main hierarchy;
- acid primary action, neutral secondary action, rust error treatment;
- responsive collapse to a horizontal progress strip below 800px;
- visible `:focus-visible` outlines and sufficient contrast;
- semantic headings, ordered step list, and `aria-live` status regions.

## Error and navigation rules

- Public status failures show a retry action.
- Unauthorized detail/mutation responses remain terminal and do not leak setup data.
- Mutation failures remain in the current step and expose retry.
- Completed steps are review-only; no client-side rollback or free navigation.
- Completion redirects direct `/onboarding` visits to the dashboard through existing route-gate behavior.

## Verification

Add/update focused UI tests for:

- first-admin and returning-admin sign-in copy and GitHub action;
- non-admin terminal state without setup data;
- five-step rail current/completed/locked semantics;
- completed-step review mode without mutation controls;
- worker, resource acknowledgement, labels, and completion content;
- responsive class/state contracts where practical.

Run `bun run typecheck`, focused onboarding/UI tests, `bun test`, and verify the running local flow in a browser at `/onboarding`.
