# Remove Settings resource limits

## Status

Complete. Commit `688db5d` (`refactor(web): remove settings resource limits`).

## Changes

- Removed the per-organization resource-limit table and deployment organization settings section from `SettingsPage`.
- Removed organization settings queries, row form state, validation/save mutation, conversion helpers, and related imports.
- Kept the deployment Settings shell, signed-in identity, route organization selection used by GitHub integration, GitHub connection management, and GitHub API rate-limit cards.
- Removed CSS used exclusively by the deleted resource table while preserving shared deployment and GitHub card styles.
- Replaced resource-form tests with assertions that obsolete labels/table markup are absent and GitHub Settings content remains covered.
- Left organization-settings API functions/contracts unchanged.

## Validation

- `bun test apps/web/src/routes/SettingsPage.test.tsx` — 7 passed, 0 failed.
- `bun run --filter '@mars/web' typecheck` — passed.
- `git diff --check` — passed.

## Concerns

None identified. Backend organization-settings routes remain available for other callers.
