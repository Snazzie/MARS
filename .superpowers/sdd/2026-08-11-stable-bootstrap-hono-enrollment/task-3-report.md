# Task 3 report

Implemented and hardened stable worker bootstrap enrollment.

- Singleton hash-only bootstrap credential schema/service with initialize, verify, rotate, status, row locking, generation-only audit events, and ISO timestamps.
- Restored workers table creation ordering, active identity indexes, installer audience validation, and Bun artifact responses.
- Enrollment accepts audience from JSON body or query and preserves `{code, expiresAt, installer}` compatibility.
- Join applies a bounded per-source limiter (maximum 1024 tracked sources, five attempts per minute) before credential verification, keyed exclusively by injected trusted `deps.requestSource(request)`, returns generic 401s for invalid/throttled attempts, and clears source state after successful verification.
- Removed obsolete enrollment symbols while preserving worker signing/adoption behavior.
- Updated dashboard HTTP fake DB coverage for bootstrap and worker queries.
- Focused tests cover lifecycle, rotation-before-initialization guard, hash-only verification, and rotation invalidation.

Verification:
- `bun test apps/control-plane/src/worker-bootstrap.test.ts apps/control-plane/src/dashboard-api.test.ts` — 9 pass, 0 fail, 28 expects.
- `bun run --filter '@mars/db' typecheck` — pass.
- `bun run --filter '@mars/control-plane' typecheck` — pass.

No broad validation was run.
