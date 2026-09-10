# Mars Implementation Status

MARS is an active development baseline, not a production-ready platform.

## Linux/amd64 control-plane hosting MVP

Issue #9 defines this milestone as control-plane hosting only: one immutable Linux/amd64 OCI image, operator-managed PostgreSQL 17, durable `DATA_ROOT` and `app_master_key`, health/dashboard identity, GitHub App onboarding, signed webhooks, browser and authenticated worker WebSockets through HTTPS ingress, immutable worker-release binding, deployment/restart/upgrade/rollback/recovery proof, SBOM, and keyless provenance.

Repository implementation for the automated gates is present, but release evidence is **pending** until the exact SHA passes CI and a candidate passes the published-digest Compose, ingress, upgrade/recovery, anonymous-pull, SBOM, and attestation gates. The protected environment and real staging observations are external blockers, not represented as completed here.

## Explicit limitations

- GitHub Actions job execution, Linux runner lifecycle, and issue #6 remain open.
- Linux/arm64 and multi-architecture control-plane images are unsupported.
- High availability and multi-replica control planes are unsupported.
- PostgreSQL is never bundled in the production image or control-plane Compose stack.
- Worker binaries are never bundled in the control-plane image.
- Operators must not override the image-owned worker manifest or contract version.
- No platform-wide “production-ready runner platform” claim is made.

## Current evidence

- `apps/orchestrator/src/kata-k3s.ts` still contains the in-memory job-execution boundary; issue #6 owns that work.
- `apps/job-agent/src/index.ts` accepts and hashes a claim but does not execute jobs.
- `apps/control-plane/src/github.ts` contains OAuth and GitHub App integration boundaries; real GitHub staging remains required.
- `deploy/control-plane/compose.yaml` requires an immutable image input and external PostgreSQL 17.
- `tests/control-plane-compose-smoke.sh` and `tests/control-plane-upgrade-recovery-smoke.sh` are release-run gates; they have not been observed against a published candidate in this repository-only change.

## External release blockers

A protected `control-plane-staging` environment, public GHCR package, clean Linux/amd64 host, operator-managed PostgreSQL 17, real DNS/TLS ingress, disposable GitHub App/account/repository, GitHub delivery/WebSocket observations, coordinated backup/restore evidence, and final release publication are still pending. Do not mark the milestone shipped until those observations and release evidence are attached.

## Database ownership

Drizzle ORM owns the PostgreSQL runtime client, generated schema, relations, and checked-in migrations. Existing query modules execute through the Drizzle-backed database client while preserving their SQL semantics and result contracts.
