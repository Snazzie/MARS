# Task 3 report

Implemented and hardened the stable deployment-wide worker bootstrap credential.

- Added singleton `worker_bootstrap_credentials` schema, removed `worker_join_codes`, restored workers table creation ordering, added `workers.last_requested_at`, and active identity uniqueness indexes.
- Added hash-only initialize/verify/rotate/status service with base64url 256-bit codes, timing-safe verification, row-locked rotation, generation-only audit payloads, and ISO timestamp outputs.
- Wired Hono installer/enrollment/join routes, preserving installer audience validation and `{code, expiresAt, installer}` response compatibility. Invalid/rotated/throttled join attempts use one generic 401 response.
- Added bounded per-source join-attempt limiting with successful-source reset.
- Removed obsolete enrollment symbols and preserved worker signing/adoption behavior.
- Added focused lifecycle test covering reveal shape, initialization uniqueness, hash-only verification, and rotation invalidation.

Focused verification:
- `bun test apps/control-plane/src/worker-bootstrap.test.ts` — 1 pass, 0 fail.
- `bun run --filter '@whitesmith/db' typecheck` — pass.
- `bun run --filter '@whitesmith/control-plane' typecheck` — pass.

No broad validation was run.
