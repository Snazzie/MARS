
## Review fixes
- Added the composite uniqueness boundary required by the step foreign key and a unique organization/run/job/step-number index to make replay persistence idempotent.
- Guarded zero-limit step-log pagination before querying/cursor indexing.
- Re-ran `bun test packages/db/src/dashboard.test.ts` (8 pass, 0 fail) and DB typecheck (passed).
