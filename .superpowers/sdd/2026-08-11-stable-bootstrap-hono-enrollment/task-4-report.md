# Task 4 report

## Status
Implemented pending worker request contracts, bootstrap-code authentication, source rate limiting, duplicate identity idempotency, identity conflict auditing, global-admin approval/rejection routes, and focused security tests.

## Verification
- `bun test ./apps/control-plane/src/worker-requests.test.ts` — 3 pass, 0 fail, 11 assertions.
- `bun test apps/control-plane/src/worker-bootstrap.test.ts apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/worker-dispatch.test.ts tests/worker-dispatch.test.ts` — 14 pass, 0 fail, 44 assertions.

## Notes
Invalid/rotated bootstrap credentials use generic 401 responses; limiter exhaustion returns 429. Approval requires a global-admin session, idempotency key, organization UUID, and positive worker limits. Bootstrap reveal responses are `no-store`; status and pending responses do not reveal codes.
## Hardening follow-up
- Commit `5e87d8f` preserves admin-approved limits on reconnect, verifies bootstrap credentials under the worker advisory lock, audits identity conflicts after rollback, restores `/api/workers/enroll`, returns 400 for malformed approval payloads, and validates bounded doctor/capacity data.
## Capacity follow-up
- Commit `e23aa9c` refreshes parsed doctor/capacity telemetry on exact reconnect without changing admin-approved limits, enforces integer bounded resource fields, and tests fractional rejection. `/api/workers/enroll` remains as a compatibility route for the existing web client.
## Compatibility follow-up
- The enrollment compatibility route now parses and validates the body/audience before singleton initialization, so malformed requests cannot consume the bootstrap credential. Focused verification remains 14 passing tests and both package typechecks.
## Identity race follow-up
- Commit `dd46ba9` acquires sorted transaction-scoped advisory locks for machine UUID, VM UUID, and public-key fingerprint before credential verification and identity lookup, serializing all uniqueness dimensions.
