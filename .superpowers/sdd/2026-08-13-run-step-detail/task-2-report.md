# Task 2 report

## Files
- `apps/control-plane/src/runs.ts`: normalized step snapshots, webhook validation, and monotonic `dashboard_job_steps` upserts via `applyGithubJobSnapshot`.
- `apps/control-plane/src/github-jobs.ts`: REST step parsing, queued-status normalization, strict malformed-payload rejection, duration calculation.
- `apps/control-plane/src/github-jobs.test.ts`: REST step normalization and malformed payload coverage.
- `apps/control-plane/src/runs.test.ts`: queued and terminal timestamp/duration invariants.

`github-app.ts` and `job-discovery.ts` already route webhook/discovery data through the shared snapshot path and required no source changes.

## Verification
- `bun test apps/control-plane/src/runs.test.ts apps/control-plane/src/github-jobs.test.ts` — 5 passed.
- `bunx tsc --noEmit -p apps/control-plane/tsconfig.json` — passed.

## Review fixes
Strict positive integer step numbers; malformed webhook `steps` containers fail with `github_payload_invalid`; stable GitHub IDs replace synthetic number IDs while preserving step-number uniqueness.

## Commit
`1816db9`

## Concerns
Full PostgreSQL convergence requires integration fixtures; focused control-plane tests/typecheck pass. Worker log event wiring untouched.


## Final persistence-boundary coverage
- `apps/control-plane/src/runs.test.ts` now uses a deterministic tagged-SQL recorder to invoke both `applyGithubJobSnapshot` and `applyWorkflowJobWebhook` through the same transaction path.
- The focused regression asserts equivalent run/job/step writes, conflict-based duplicate prevention, queued status/timestamp behavior, monotonic `LEAST`/`COALESCE` clauses, and synthetic step-ID promotion to a stable GitHub ID.

## Final verification
- `bun test apps/control-plane/src/runs.test.ts` — 3 passed, 23 assertions.
- `bunx tsc --noEmit -p apps/control-plane/tsconfig.json` — passed.
- Final review fix: replaced textual SQL assertions in `runs.test.ts` with an executable deterministic transaction fake that applies the same run/job/step monotonic upsert rules and exposes stored state.
- Coverage now exercises REST and equivalent webhook convergence, queued `started_at` null, earliest start/first completion preservation, terminal non-regression, duplicate prevention, label normalization, synthetic step-number ID promotion to a stable GitHub ID, and strict malformed webhook step validation.
- Final verification: `bun test apps/control-plane/src/runs.test.ts apps/control-plane/src/github-jobs.test.ts` — 6 passed, 20 assertions; `bun run --filter @whitesmith/control-plane typecheck` — passed.