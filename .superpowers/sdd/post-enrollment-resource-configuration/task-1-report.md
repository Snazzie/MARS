# Task 1 report

## Changed files
- `packages/contracts/src/orchestration.ts`: removed `limits` from strict `WorkerBootstrapRequest`; adoption `WorkerLimits` remains unchanged.
- `apps/control-plane/src/worker-requests.ts`: pending worker inserts now persist SQL `NULL` limits while retaining doctor/capacity telemetry.
- `apps/control-plane/src/worker-requests.test.ts`: limit-free and strict-rejection contract coverage.
- `apps/control-plane/src/worker-requests.persistence.test.ts`: focused pending persistence behavior test.
- `apps/orchestrator/src/mac-agent.ts`: Mac join payload no longer accepts or emits limits; runtime driver limits remain local for later job execution.
- `apps/orchestrator/src/mac-agent.test.ts`: verifies limit-free Mac payload.

## Verification
- `bun test apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/worker-requests.persistence.test.ts apps/orchestrator/src/mac-agent.test.ts` — 8 pass, 0 fail, 21 expect() calls.
- `bun run --filter @whitesmith/control-plane typecheck` — exit 0.
- `bun run --filter @whitesmith/orchestrator typecheck` — exit 0.

## Commit
- Implementation commit: `a5149e1`.

## Concerns
- Windows uses the shared limit-free `runWorkerJoin` payload path; no Windows-specific limits payload exists.
- Existing unrelated workspace changes were preserved.
