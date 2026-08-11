# Task 7 report

## Status
Implemented pending worker approval UI and focused tests.

## Changes
- Added global pending-worker query and Hono approve/reject API clients with idempotency keys and contract validation.
## DTO alignment follow-up

- Aligned the Hono pending response with the strict no-secret UI DTO: public key/fingerprint, VM/machine identity, limits, and bounded doctor/capacity telemetry.
- Added a copy control for the fingerprint and verified the parsed DTO renders in the focused UI test.

## Verification
- `bun test apps/web/src/components/PendingWorkerRequests.test.tsx` — 2 passed.
- `bun run --filter '@whitesmith/web' typecheck` — passed.
- `bun run --filter '@whitesmith/control-plane' typecheck` — passed.
