# Task 2 — Settings GitHub connection and rate limit cards

Status: Complete

Commits: `8f28a62` (`feat(web): add GitHub settings cards`), `fc1a127` (`fix(web): distinguish unknown GitHub quota state`), `64a9ede` (`fix(web): guard GitHub removal and stale states`), `b740897` (initial report), `9a0235c` (quota-state report update), and the current report update commit.

Tests/output:

- `bun test apps/web/src/routes/SettingsPage.test.tsx` — 6 pass, 0 fail, 27 expect() calls.
- `bun test apps/web/src/routes/SettingsPage.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx` — 13 pass, 0 fail, 52 expect() calls.
- `bun run --filter '@mars/web' typecheck` — exited with code 0.

Implemented disconnected and connected GitHub installation states, install/manage/sync/remove actions, query invalidation for connection/rate-limit/repositories/organizations after mutating actions, separate signed-in identity/sign-out, and rate-limit remaining/limit/used/reset metrics with refresh, loading, error, and disconnected states.

Concerns: Browser smoke testing was not run in this focused task; no known functional concerns from focused tests or type validation.
