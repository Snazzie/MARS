# Final fix wave

Implemented all five final review findings:

- Configuration now atomically adopts pending workers, binds organization/resources, persists the durable configure command, and gates readiness on exact current command/revision acknowledgement.
- Orchestrator command handling consumes `worker.configure`, applies runtime limits, and emits exact `worker.configured` acknowledgement.
- POSIX installers reject all code arguments and require a hidden controlling-TTY prompt.
- macOS worker join validates canonical HTTPS/loopback URL, uses a 30-second timeout, and zeroes code buffers in `finally`.
- Late acknowledgements cannot ready a newer configuration.

Verification:
- `bun test apps/orchestrator/src/mac-agent.test.ts apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/worker-requests.persistence.test.ts tests/installer-arguments.test.ts` — 19 pass, 0 fail, 77 assertions.
- `bunx tsc --noEmit -p apps/orchestrator/tsconfig.json` — pass.
- `bunx tsc --noEmit -p apps/control-plane/tsconfig.json` — pass.

Concerns: full repository verification was not rerun in this final wave; unrelated pre-existing worktree changes were preserved and excluded from the fix commit.
