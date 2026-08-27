# Control Plane Deployment Readiness Design

## Goal

Make the Mars control-plane hosting layer releasable and deployable on Unraid through Docker/Compose. This work does not make the worker execution platform production-complete. Cloudflare Tunnel remains an operator-managed, external ingress option and is not required by the core deployment.

## Scope

### In scope

- Correct production image references and immutable digest handling.
- Correct Compose-relative secret and optional tunnel paths.
- Publish immutable control-plane images to GHCR from CI.
- Generate release metadata suitable for operator deployment.
- Validate the production image contents and startup contract.
- Provide a safe `.env.example` and operator deployment documentation.
- Document PostgreSQL and control-plane persistence, upgrades, rollback, backups, and health checks.
- Document Unraid reverse-proxy and WebSocket networking requirements without coupling the application to Cloudflare.
- Preserve the existing control-plane image contract and worker artifact packaging.

### Out of scope

- Implementing Kata/K3s execution.
- Completing GitHub App lifecycle behavior.
- Completing Windows/macOS/Linux worker runtimes.
- Building an Unraid-specific application plugin.
- Provisioning or operating Cloudflare Tunnel.
- Claiming end-to-end production job execution readiness.

## Deployment contract

The required stack is two services:

1. `control-plane`: immutable GHCR image, port 3000, `/var/lib/mars` persistent volume, and `app_master_key` Docker secret.
2. `postgres`: PostgreSQL 17 image and persistent database volume.

The optional `cloudflared` Compose profile is not part of the required stack. If retained, it must be independently correct and documented as optional.

The control plane must be reachable through an operator-selected ingress path that supports HTTP, HTTPS termination, and WebSocket upgrade forwarding. The application itself remains unaware of the ingress implementation.

## Image and release flow

CI will:

1. Install dependencies with the pinned Bun version.
2. Run typecheck and the complete test suite.
3. Build the workspace.
4. Build the Linux control-plane image using the existing Dockerfile.
5. Verify required runtime artifacts inside the image.
6. Run a container smoke test against a disposable PostgreSQL service or equivalent startup fixture.
7. Push the image to GHCR only for an approved release trigger.
8. Resolve and record the pushed `repository@sha256:<digest>` reference.
9. Publish release metadata, including the digest and build identifier.
10. Generate SBOM/provenance using supported Docker Buildx capabilities.

The production Compose file will consume a repository plus digest using Docker's `@sha256:` syntax. Mutable tags are not accepted as the production deployment reference.

## Configuration and secrets

`.env.example` will contain non-secret placeholders and comments for every required deployment variable. It will not contain usable credentials.

The operator will generate:

- `app_master_key`: base64-encoded 32-byte key stored as a Docker secret.
- PostgreSQL password: supplied through the deployment environment or an Unraid-managed secret mechanism.
- GitHub OAuth and webhook credentials: supplied through environment configuration.

The deployment documentation will state that changing `APP_MASTER_KEY` after data exists makes encrypted values unreadable and therefore requires an explicit key-rotation/migration procedure.

## Persistence and operations

Documentation will define:

- PostgreSQL backup and restore.
- Control-plane data-volume backup and restore.
- Safe image upgrades using immutable digests.
- Rollback to a previous digest.
- Migration behavior during startup.
- Readiness and liveness checks.
- Expected startup failure modes.
- Required log and diagnostic collection.

## Unraid networking

The documentation will describe two supported patterns:

- Host-level reverse proxy reaching the host-published control-plane port.
- Containerized reverse proxy sharing a Docker network with the control plane.

It will explicitly require WebSocket forwarding for the control-plane API and will not assume Cloudflare Tunnel is installed.

The Compose port binding will be chosen/documented so it is compatible with the supported Unraid proxy pattern without silently exposing the service beyond the intended host boundary.

## Verification

The implementation is complete only when all of the following are demonstrated:

- Production Compose interpolation succeeds with the example configuration.
- Secret and optional-file paths resolve relative to the Compose file.
- The release image builds on a Linux Docker builder.
- The image contains the control-plane bundle, web assets, and worker artifacts required by production startup checks.
- The image starts with PostgreSQL and reaches `/api/livez` and `/api/readyz` under the documented configuration.
- The complete test suite passes.
- CI publishes and records an immutable image digest for a release.
- The deployment documentation is sufficient for a clean Unraid installation without requiring Cloudflare Tunnel.

The final status must distinguish control-plane hosting readiness from unfinished worker-runtime readiness.
