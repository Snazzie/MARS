# Final-review blocker fixes

- Pending-worker configuration now registers an already-authenticated socket before the transactional `worker.configure` command is replayed, preserving durable command persistence and authentication checks.
- Linux orchestrator now consumes `worker.configure`, applies appliance/runtime resources, and emits a schema-valid `worker.configured` frame containing worker ID, command ID, revision, and exact observed values.
- Configuration acknowledgements now mutate error state only when both command ID and revision still match the persisted current configuration identity; stale same-revision acknowledgements are ignored.

Focused verification: `bun test apps/orchestrator/src/linux-agent.test.ts apps/control-plane/src/worker-dispatch.test.ts apps/control-plane/src/worker-requests.persistence.test.ts` — 8 passed, 0 failed.
