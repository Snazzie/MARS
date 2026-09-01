# Task 1 — Worker release contract

## Delivered

- Replaced the worker release schema with strict schema version 3.
- Added reusable strict HTTPS hashed assets (`url` plus lowercase 64-character SHA-256), digest-pinned OCI references, and the exact Linux, Windows-container, and macOS platform records from the release-train contract.
- Kept all three manifest platform keys nullable so unavailable platforms can be represented explicitly; production Linux non-null enforcement remains the responsibility of the production loader.
- Added `deploy/workers/contract-version.txt` with contract version `0.1.0`.
- Migrated the packaged development and control-plane smoke manifest fixtures to schema 3.
- Expanded focused contract tests for complete schema 3 acceptance, explicit null platforms, schema 2 rejection, strict unknown-field rejection, HTTP URL rejection, malformed/uppercase hash rejection, mutable OCI rejection, and incomplete platform rejection.

## Verification

- `bun test packages/contracts/src/worker-release.test.ts` — 8 pass, 0 fail.
- Parsed both migrated JSON fixtures through `WorkerReleaseManifest.parse` — `fixtures valid`.

## Concerns / handoff notes

- Existing control-plane and installer callers still reference schema 2 field names by design; later release-train tasks must migrate those callers to the schema 3 asset objects and immutable OCI fields.
- The shared control-plane test dependency fixture has now been migrated; production control-plane loader and installer callers still require the later schema-3 implementation.

## Follow-up fixture migration

- Migrated the shared control-plane loader test, HTTP test dependency manifest, and HTTP app test manifests to schema 3 with deterministic HTTPS asset URLs, lowercase hashes, and digest-pinned OCI references.
- Removed schema-2-only VHDX/Tart metadata from those manifest records and supplied all required Windows container build inputs plus macOS preparation metadata.
- Focused loader test run after fixture migration: `bun test apps/control-plane/src/worker-release.test.ts` — 8 pass, 1 fail. The remaining failure is expected until the later control-plane loader change merges: the current schema-2 development override merger leaves the schema-3 Windows platform unavailable.
