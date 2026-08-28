# Mars Migration Consolidation Design

## Goal
Replace the historical migration chain with one clean Mars baseline for fresh deployments.

## Scope
- Generate one `0000_mars_baseline.sql` from the final SQL schema in `packages/db/src/schema.ts`.
- Replace the Drizzle journal with one baseline entry.
- Remove superseded numbered migration files.
- Keep database creation and startup migration ordering unchanged.
- Reset the local `mars` database only after the new baseline is ready.

## Compatibility
This is a repository-wide reset. Databases stamped with the old migration journal are not automatically converted. Operators must recreate those databases or explicitly stamp them after independently verifying schema equivalence. No production database is dropped by application startup.

## Correctness
The baseline must run on an empty database, include all final tables, columns, indexes, constraints, JSON normalization requirements, onboarding verification fields, telemetry fields, worker enrollment replay fields, and the `webhook_deliveries.state` column required by retention cleanup. A second startup must be idempotent.

## Verification
Run focused migration tests against fresh and already-initialized databases, then run the control-plane readiness check against the Windows PostgreSQL container. Record any pre-existing schema data loss as an explicit reset consequence.
