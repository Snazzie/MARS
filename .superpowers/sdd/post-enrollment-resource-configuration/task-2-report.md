
## Scoped re-review fixes

Restored global-admin authorization on configure and moved idempotency after request validation, with successful response replay to avoid duplicate dispatch. Typecheck passed; focused HTTP/request/dispatcher tests passed (15 tests, 41 assertions).