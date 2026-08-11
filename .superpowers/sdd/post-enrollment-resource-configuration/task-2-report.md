
## Atomic durable command fix

Configuration now claims `(organization,idempotency key)` under a transaction advisory lock, persists worker policy, durable `worker.configure` command, audit, and successful response atomically. The route no longer sends an external socket command before commit; dispatcher replay consumes the committed command. Typecheck and focused tests passed (12 tests, 30 assertions).