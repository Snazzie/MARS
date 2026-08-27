# Task 6 report

Implemented show-once bootstrap command generation and enrollment UI.

- `buildInstallerCommand` requires a platform and code, validates HTTPS/loopback policy, safely quotes installer URLs and codes, and places code only in final installer invocation.
- Focused command tests cover all platforms, protocol policy, invalid inputs, and metacharacter quoting.
- Added no-store bootstrap status/initialize/rotate API clients.
- Enrollment wizard reads bootstrap status, initializes or explicitly confirms rotation, reveals code once, renders Linux/Windows/macOS command blocks with copy actions, and clears reveal state on close.
- Added authenticated global-admin Hono rotate route with no-store response and uninitialized conflict handling.

Verification:
- `bun test apps/control-plane/src/http/app.test.ts apps/web/src/components/EnrollmentWizard.test.ts` — 12 passed.
- `bun run --filter '@mars/control-plane' typecheck` — passed.
- `bun run --filter '@mars/web' typecheck` — passed.
