# Task 6 report

Implemented show-once bootstrap command generation and enrollment UI.

- `buildInstallerCommand` now requires a platform and code, validates HTTPS/loopback policy, safely quotes installer URLs and codes, and places code only in final installer invocation.
- Added focused command tests for all platforms, protocol policy, empty/unsupported inputs, and metacharacter quoting.
- Added no-store bootstrap status/initialize/rotate API clients.
- Enrollment wizard now reads bootstrap status, initializes or explicitly confirms rotation, reveals code once, renders Linux/Windows/macOS command blocks with copy actions, and clears reveal state on close.
- Removed per-request profile enrollment from the wizard.

Verification:
- `bun test apps/web/src/components/EnrollmentWizard.test.ts` — 7 passed.
- `bun run --filter '@whitesmith/web' typecheck` — passed.
