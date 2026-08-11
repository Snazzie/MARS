
## Durable idempotency fix

Configuration mutation responses now persist in `dashboard_mutations.response`; retries after process restart replay the durable response without dispatch. Keys are written only after configuration and dispatch succeed, leaving failed attempts retryable. Focused typecheck and HTTP/request/dispatcher tests passed (15 tests, 41 assertions).