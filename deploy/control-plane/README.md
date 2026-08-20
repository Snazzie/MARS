# Control Plane Docker Deployment

This directory contains the production Docker image and Compose stack for the Whitesmith control plane. The required stack is the control plane plus PostgreSQL. Cloudflare Tunnel is optional and operator-managed; it is not required to run the application.

## Prerequisites

- Unraid with a Linux Docker engine and Docker Compose support.
- A deployment directory containing this `compose.yaml`, a populated `.env`, and an `app_master_key` file beside the Compose file.
- A published control-plane release tag selected by the Unraid template.
  The Compose fallback is `ghcr.io/whitesmith/control-plane:latest`.
- An ingress or reverse proxy if the service must be reachable outside the Unraid host.


## Unraid template

Import `deploy/unraid/whitesmith-control-plane.xml` into Unraid's Docker templates. The template selects a versioned image tag such as `v0.1.0`; update that tag for upgrades. It configures the control-plane port, persistent data path, master-key file, database URL, and GitHub credentials. It does not ask for image digests or Windows worker download hashes.

The XML template runs the control plane as a single container. PostgreSQL must be provided by the Compose `postgres` service or an existing PostgreSQL 17 container reachable through the configured `DATABASE_URL`.

Windows worker build URLs and SHA-256 values are release metadata, not operator configuration. Release CI embeds them in `/app/release-manifest.json`; they are not read from `.env` or the Unraid template. A release without that metadata can host the control plane but returns `artifact_unavailable` when a Windows container worker installer is requested.

Release CI reads the following non-secret GitHub repository variables when publishing a tagged image: `WHITESMITH_WINDOWS_CONTAINER_BASE_IMAGE`, `WHITESMITH_WINDOWS_CONTAINER_RUNNER_URL`, `WHITESMITH_WINDOWS_CONTAINER_RUNNER_SHA256`, `WHITESMITH_WINDOWS_CONTAINER_GIT_URL`, `WHITESMITH_WINDOWS_CONTAINER_GIT_SHA256`, `WHITESMITH_WINDOWS_CONTAINER_VC_URL`, and `WHITESMITH_WINDOWS_CONTAINER_VC_SHA256`.
The control plane coordinates external workers. Unraid does not provide the Windows Hyper-V or K3s/Kata runtime required to execute every worker platform inside this container.

## Prepare configuration

Run these commands from the repository/deployment root, or copy the same files into an Unraid application directory:

```bash
cp .env.example .env
chmod 600 .env
```

Generate the encryption key beside the Compose file:

```bash
openssl rand -base64 32 > deploy/control-plane/app_master_key
chmod 600 deploy/control-plane/app_master_key
```

If you copied only `deploy/control-plane` to Unraid, write the key as `./app_master_key` beside `compose.yaml` instead.

`APP_MASTER_KEY` is mounted as a Docker secret. Keep the same key for the lifetime of the deployment. Changing it without a planned key-rotation migration makes existing encrypted GitHub credentials unreadable.

Set `PUBLIC_BASE_URL` to the externally reachable HTTPS origin used for GitHub callbacks. Set `BROWSER_BASE_URL` to the browser-facing origin; it may be the same value.

## Start the required stack

Run from the repository/deployment root, or pass the file explicitly:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml up -d postgres control-plane
```

Check service state and logs:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml ps
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs -f control-plane
```

The control plane runs migrations during startup. The healthcheck polls `/api/readyz`, which requires both PostgreSQL and the discovery monitor to be healthy.

## Health checks

- Liveness: `GET /api/livez`
- Readiness: `GET /api/readyz`
- Operational health: `GET /api/healthz`

A local host-level check is:

```bash
curl --fail http://127.0.0.1:3000/api/livez
curl --fail http://127.0.0.1:3000/api/readyz
```

## Reverse proxy and WebSockets

The default Compose binding publishes port 3000 on the Unraid host loopback interface. A host-level reverse proxy can forward to `127.0.0.1:3000`.

For a reverse proxy running in another Docker container, place the proxy and control-plane services on a shared Docker network and proxy to the service name and port 3000, or use an explicit host-gateway configuration. Do not assume another container can reach the host loopback binding.

The proxy must:

- terminate HTTPS;
- forward `Host`, `X-Forwarded-Proto`, and client-request metadata;
- support WebSocket upgrade and long-lived connections for the control-plane API;
- preserve the configured `PUBLIC_BASE_URL` origin.

Cloudflare Tunnel may be installed separately by the operator. It is optional and is not needed by the core Compose stack.

## Persistence and backups

The stack uses two named volumes:

- `control-plane_whitesmith-data`: diagnostic files and control-plane persistent data.
- `control-plane_postgres-data`: PostgreSQL data.

Back up PostgreSQL with `pg_dump` before upgrades:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml exec -T postgres \
  pg_dump -U whitesmith -d whitesmith > whitesmith-$(date +%Y%m%d).sql
```

Back up the control-plane volume using the Unraid backup system or a stopped-container volume archive. Test restoration on a separate deployment before relying on it.

## Upgrade and rollback

Update the image tag in the Unraid template to the new release, then recreate the control-plane service:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml pull control-plane
docker compose --env-file .env -f deploy/control-plane/compose.yaml up -d control-plane
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs --tail=100 control-plane
```

Keep the previous release tag available until the new deployment passes `/api/readyz` and the browser smoke check. Roll back by restoring the previous tag and recreating the service. Do not remove PostgreSQL or the data volume during an application rollback.

## Database migrations

Control-plane startup runs the checked-in Drizzle migration set. The existing numbered migrations remain a frozen compatibility boundary for installations that already contain `schema_migrations`; new schema changes must use Drizzle migration files and must not extend the legacy migration list.

For a development database:

```bash
DATABASE_URL=postgres://whitesmith:password@localhost:5432/whitesmith \
  bun run --cwd packages/db db:migrate
```

Back up PostgreSQL before upgrades. A migration failure keeps the control-plane process unhealthy and must be corrected before retrying startup.

## Optional tunnel profile

The optional `tunnel` profile uses files beside this Compose file. It is not part of the required deployment and does not replace an Unraid ingress configuration. Operators who manage Cloudflare separately should omit this profile entirely.

## Scope boundary

This package makes the control-plane hosting layer deployable. It does not imply that all worker runtimes, GitHub App lifecycle operations, Kata execution, or Windows/macOS worker paths are production-complete. Those remain separate release gates.
