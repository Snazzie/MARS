# Deployment-wide settings implementation

## Status
Implemented and committed as `5b3ad80` (`feat(web): make settings deployment-wide`).

## Changes
- `/settings` now loads every organization and each organization settings record with React Query `useQueries`.
- Replaced the organization-gated settings form with an accessible organization table containing memory, storage, maximum concurrent pods, and row-level Save controls.
- Removed vCPU from visible settings UI while preserving each row's existing `maxVcpuPerPod` in update payloads.
- Preserved signed-in identity and GitHub connection/rate-limit cards in a clearly separated deployment integrations section. Existing organization-scoped GitHub APIs use the current organization when valid, otherwise the first organization.
- Workspace selectors are hidden in both desktop and mobile AppShell contexts for `/settings` and settings subroutes only.
- Settings navigation is standalone and exposes `General` without a numeric prefix.
- Added focused rendering, route detection, payload-preservation, and row-save coverage.

## Verification
- `bun test apps/web/src/routes/SettingsPage.test.tsx` — 11 passed, 0 failed.
- `bun run --filter '@mars/web' typecheck` — passed.
- `git diff --check` — passed for changed source/test/style files.

## Concerns
- GitHub connection and rate-limit endpoints remain organization-scoped because backend contracts were intentionally unchanged; the deployment section explains this and selects the current/first organization.
- AppShell still obtains organizations for global shell state, but selector controls are not rendered on settings routes.
