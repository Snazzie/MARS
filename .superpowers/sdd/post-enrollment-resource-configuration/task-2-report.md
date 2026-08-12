
## Atomic durable command fix

Configuration now claims `(organization,idempotency key)` under a transaction advisory lock, persists worker policy, durable `worker.configure` command, audit, and successful response atomically. The route no longer sends an external socket command before commit; dispatcher replay consumes the committed command. Typecheck and focused tests passed (12 tests, 30 assertions).

## Task 2 remaining race fixes

Committed durable configuration commands now trigger replay on an already-authenticated worker socket after the transaction commits, while retaining the command row for reconnect/crash replay. Same-key requests acquire the transaction advisory lock and return the stored successful response instead of raising a 500; focused tests cover active-socket replay and duplicate idempotency without mutation. Focused tests: 12 passing, 33 assertions; control-plane typecheck passes.