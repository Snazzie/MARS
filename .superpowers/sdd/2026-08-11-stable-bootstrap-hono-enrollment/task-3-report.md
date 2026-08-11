# Task 3 report

Implemented the stable deployment-wide worker bootstrap credential.

- Added singleton `worker_bootstrap_credentials` schema, removed `worker_join_codes`, added `workers.last_requested_at`, and active identity uniqueness indexes.
- Added hash-only initialize/verify/rotate/status service with base64url 256-bit codes, timing-safe verification, row-locked rotation, and generation-only audit payloads.
- Wired Hono worker enrollment and join routes; invalid and rotated credentials use the same generic response.
- Removed obsolete enrollment symbols and preserved worker signing/adoption behavior.
- Added focused lifecycle test covering reveal shape, initialization uniqueness, hash-only verification, and rotation invalidation.

Focused verification:
- `bun test apps/control-plane/src/worker-bootstrap.test.ts` — 1 pass, 0 fail.
- `bun run --filter '@whitesmith/db' typecheck` — pass.
- `bun run --filter '@whitesmith/control-plane' typecheck` — pass.

No broad validation was run.
