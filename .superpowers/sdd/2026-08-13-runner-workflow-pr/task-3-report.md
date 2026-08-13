
## Review fixes
- Made workflow job `path` and `proposedRunsOn` required in the strict contract.
- Added atomic dashboard mutation reservation and response replay for PR idempotency keys; repeated submissions return the stored PR result.
- Mapped malformed/unsupported/invalid path/not-discovered/no-op workflow failures to safe 422 responses for preview and create.
- Verification: `bun test apps/control-plane/src/dashboard-api.test.ts` (9 pass); control-plane and web typechecks pass.
