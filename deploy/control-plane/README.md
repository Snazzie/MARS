# Control Plane Docker Deployment

This directory contains the production Docker image and Compose stack for the Whitesmith control plane. The required stack is the control plane plus PostgreSQL. Cloudflare Tunnel is optional and operator-managed; it is not required to run the application.

## Prerequisites

- Unraid with a Linux Docker engine and Docker Compose support.
- A deployment directory containing this `compose.yaml`, a populated `.env`, and an `app_master_key` file beside the Compose file.
- A GitHub OAuth application and webhook secret.
- An immutable control-plane image digest published to GHCR.
- An ingress or reverse proxy if the service must be reachable outside the Unraid host.

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

Update `WHITESMITH_RELEASE_DIGEST` to the new immutable digest, then recreate the control-plane service:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml pull control-plane
docker compose --env-file .env -f deploy/control-plane/compose.yaml up -d control-plane
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs --tail=100 control-plane
```

Keep the previous digest until the new deployment passes `/api/readyz` and the browser smoke check. Roll back by restoring the previous digest and recreating the service. Do not remove PostgreSQL or the data volume during an application rollback.

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
