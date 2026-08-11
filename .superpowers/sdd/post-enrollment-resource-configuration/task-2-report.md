
## Review fixes

Addressed recursive canonical revisions, free-capacity and aggregate concurrency validation, exact command/revision/observed acknowledgement matching, authenticated socket worker binding, and persisted dashboard mutation idempotency preventing duplicate dispatch.

Verification rerun: control-plane typecheck passed; focused worker request/dispatcher tests passed (9 tests, 27 assertions).