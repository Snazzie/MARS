# Task 5 — Deployment hardening report

## Status

Implemented the control-plane image and Unraid deployment boundary from Approach item 5.

- `deploy/control-plane/Dockerfile` now emits only the API bundle, web assets, migrations, and runtime files; installs Debian `gosu`; bakes `MARS_WORKER_RELEASE_MANIFEST_URL` and `MARS_WORKER_CONTRACT_VERSION`; declares Linux/amd64-compatible runtime metadata; and adds the requested Bun `/api/readyz` healthcheck (10s interval, 3s timeout, 60s start period, 6 retries).
- Added `deploy/control-plane/entrypoint.sh`. It runs as root only long enough to create `/var/lib/mars` (or `DATA_ROOT`), repair that directory's ownership and mode, and then `exec`s `gosu bun:bun bun run index.js`. It never recursively changes mounted application data and the application does not run as root.
- `deploy/unraid/mars-control-plane.xml` retains `control-plane:latest`, bridge mode, host port 3000, appdata, external `DATABASE_URL`, `PUBLIC_BASE_URL`, required public HTTPS `GITHUB_WEBHOOK_URL`, and optional `WORKER_BASE_URL`; removes worker manifest/contract template inputs; and states Linux/amd64 plus external PostgreSQL 17 requirements.
- `deploy/control-plane/compose.yaml` documents the image-owned worker contract, keeps operator-only environment variables, retains loopback-only binding, and uses the exact image healthcheck endpoint settings.
- Rewrote `deploy/control-plane/README.md` with the immutable worker release boundary, external PostgreSQL 17 maintenance/create/migration requirements, anonymous GHCR requirement, health diagnostics, version pin/rollback guidance, Compose loopback versus Unraid bridge/LAN behavior, onboarding/routing, and coordinated PostgreSQL + appdata backup/restore including `app_master_key`.
- Reworked `tests/control-plane-deployment-contract.test.ts` for the sole release train, separate app/worker versions and canonical images, immutable manifest URLs and promotion order, slim image/healthcheck/entrypoint, XML inputs, external database, and accurate operations documentation.

## Verification

- `bun test tests/control-plane-deployment-contract.test.ts` — **11 pass, 0 fail**.
- `docker compose --env-file tests/fixtures/control-plane-deployment.env -f deploy/control-plane/compose.yaml config -q` — **pass**.
- Docker image build was attempted with the requested local smoke build arguments. The local Windows Docker Desktop `desktop-windows` engine failed while registering the Linux base layer (`Failed to safefile.OpenRelative ... (0x7b)`), before Dockerfile execution. A Linux Docker/Buildx environment is required for the image build and `tests/control-plane-image-smoke.sh` runtime smoke. Bash is unavailable in the current Windows/WSL environment, so shell smoke could not be executed here.

## Commit

Committed in this task branch as `feat(deploy): harden control-plane image and Unraid template` (see the parent commit history for its final hash).

## Follow-up correction

- Replaced the diagnostic commands' nonexistent fixed `mars-control-plane`
  container name with `docker compose ... ps -q control-plane` and an
  image-filtered `docker ps` lookup for the Unraid-assigned ID/name.
- Re-ran the deployment contract test after this correction: **11 pass,
  0 fail**.
