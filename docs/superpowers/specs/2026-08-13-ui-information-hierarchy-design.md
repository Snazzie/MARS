# Mars UI Information Hierarchy and Responsive Design

## Status

Approved direction; implementation pending written plan.

## Goal

Reduce operator cognitive load without replacing Mars's existing visual identity. The current interface is distinctive but exposes too many peer-level controls, raw infrastructure values, and ambiguous health signals. The redesign keeps the dark operator-console aesthetic, editorial typography, and existing route model while making the primary task on each surface obvious.

## Scope

Affected surfaces:

- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/routes/RepositoriesPage.tsx`
- `apps/web/src/routes/SettingsPage.tsx`
- `apps/web/src/routes/PoolsPage.tsx`
- `apps/web/src/routes/OnboardingPage.tsx`
- `apps/web/src/routes/WorkersPage.tsx`
- shared UI state components that render loading/error/empty states
- `apps/web/src/styles.css`

Out of scope:

- API and database contracts
- route names and navigation destinations
- changes to GitHub, worker, pool, or onboarding business behavior
- new product claims or new operational metrics

## Design principles

1. One primary action per page header.
2. Group controls by task: read, filter, connect, destructive/admin.
3. Hide advanced infrastructure details until needed.
4. Never communicate backend health through a generic shell status.
5. Desktop and mobile are intentional compositions, not the same layout at different widths.
6. Preserve existing colors, typography, panel language, and status semantics unless needed for clarity or accessibility.

## App shell and responsive navigation

Desktop keeps the sticky 238px rail and numbered links. The shell status footer is supplemented by explicit scoped health states: API reachability, GitHub connection, and worker/control-plane state. Page-level failures must identify the affected request and provide the next action. The existing footer may remain only as a compact secondary indicator.

At widths below 800px, replace the clipped horizontal rail with a compact header. The header contains the brand, workspace selector, current route label, and a menu control. The menu exposes all six routes with full labels and preserves active state. It must be keyboard accessible, dismissible with Escape, and must not hide the workspace selector or current-page context. No route may be visually clipped at 390px.

Operational pages should show a client-side “Updated just now”/relative timestamp based on successful query completion time when no server-provided timestamp exists. This is presentation-only; do not add an API or database field.

## Repositories page

Make `Connect workspace` the single primary action in the header. Keep it visible when applicable.

Move `Refresh GitHub connection`, `Sync installed repositories`, and `Uninstall` into a single collapsed `GitHub connection` disclosure below the primary action. Uninstall remains visually separated as a destructive/admin action inside that disclosure and retains confirmation.

Keep repository count and list filters together in one compact filter bar. Search and availability remain immediately available. Visibility moves behind a `More filters` disclosure at all widths. The list and its empty state remain visually dominant over controls.

The page must communicate scope explicitly when `All workspaces` is selected and explain why mutating organization-specific actions are disabled.

## Settings and pool configuration clarity

Replace raw byte-facing labels with human units. Inputs should use GiB for memory and storage, while preserving existing numeric validation and converting values to bytes at the submission boundary. vCPU and concurrency remain integer fields with explicit units.

Add concise inline help for:

- vCPU
- memory and storage limits
- pool concurrency
- trigger labels
- immutable image digest
- shared versus worker-bound pools

Technical identifiers, canonical labels, and digest values remain available under an `Advanced` disclosure or secondary detail block. They are not removed; they are demoted until required for diagnosis or setup.

Pool cards should visually prioritize enabled/disabled state, worker readiness, capacity, and the action to enable/disable. Labels, image digest, and raw resource values are secondary.

## Onboarding and worker configuration

Keep the resumable onboarding wizard and durable progress model. Each step should present one decision:

1. connect GitHub/workspace;
2. select or enroll worker;
3. set human-readable capacity;
4. create or select a pool;
5. verify the first run.

Show a persistent progress indicator and a compact summary of completed prerequisites. Move raw identifiers, digests, and advanced limits behind disclosure. Worker enrollment and configuration retain existing behavior, but the header and actions must separate setup from destructive or administrative operations.

## State, errors, and accessibility

Loading, empty, and error states must be scoped to the affected page or request. A retry action must name the affected operation, for example `Retry repository sync`. Preserve user-entered filter/form state across retry where existing component lifecycle permits.

Do not rely on color alone for online, warning, failed, or selected states. Keep text labels and status icons/indicators. Ensure focus-visible styles cover menu controls, disclosures, filters, and primary actions. Maintain minimum 44px touch targets on mobile.

## Verification criteria

- At 390px wide, every primary route is reachable through a deliberate labeled navigation pattern; no nav text is clipped.
- Repositories presents one visually dominant primary action and separates connection/admin actions from filtering.
- Settings and pool configuration do not require entering memory/storage in bytes.
- Advanced technical values remain discoverable but are not first-surface content.
- Page/API/GitHub/worker health states are distinguishable in copy and recovery actions.
- Existing route behavior, query contracts, and mutation semantics remain unchanged.
- Web build and typecheck pass.
- Browser inspection confirms desktop and 390px layouts, keyboard focus, menu dismissal, disclosure behavior, and representative loading/error/empty states.
