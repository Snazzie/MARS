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

## Machine identity follow-up

- Added persisted `workers.machine_uuid`, wrote parsed machine identity on enrollment create/reconnect, and selected it in the global pending DTO.
- Distinct machine and VM UUIDs now survive enrollment and render through the strict client schema.
- Verification: focused control-plane and UI tests passed (5 total); web and control-plane typechecks passed.

## Reconnect identity follow-up

- Reconnect exactness now requires VM UUID, machine UUID, and fingerprint together; changed machine identity takes the existing conflict path and cannot overwrite stored identity.
- Added regression coverage for distinct machine identity and verified four control-plane tests plus control-plane typecheck.

## Legacy-row quarantine follow-up

- Pending DTO conversion now omits legacy rows with null/blank machine identity instead of allowing one malformed row to fail the global-admin list.
- Added quarantine predicate regression coverage; changed-machine reconnect remains a conflict and never overwrites identity.
