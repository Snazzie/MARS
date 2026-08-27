# Mars Control Plane Docker Deployment

Mars means **Managed Action Runner(s)**: the control plane for managing
GitHub Actions runners and worker execution.

This directory contains the Linux/amd64 Mars control-plane image and
PostgreSQL-only Compose stack. PostgreSQL is external to this core file;
Cloudflare Tunnel and ingress are operator-managed.

## Prerequisites

- Linux Docker Engine/Buildx and Docker Compose.
- External PostgreSQL 17 (or compatible) reachable by `DATABASE_URL`.
- An externally reachable HTTPS origin and a GitHub account for the first administrator.

## First boot

Create `.env` containing only the database DSN:

```bash
cat > .env <<'EOF'
DATABASE_URL=postgres://whitesmith:password@db.example:5432/whitesmith
EOF
chmod 600 .env
```

Start the control plane:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml up -d control-plane
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs control-plane
```

Open `/onboarding`, confirm the externally reachable HTTPS origin, and create the GitHub App. The flow then redirects to GitHub for the first administrator sign-in.

The control plane persists the generated encryption key at `${DATA_ROOT}/app_master_key` in the named `whitesmith-data` volume. Operators should back up that file together with PostgreSQL. Losing either side makes encrypted GitHub credentials unrecoverable.

## Health checks

- `GET /api/livez`
- `GET /api/readyz`
- `GET /api/healthz`

The Compose binding is loopback-only at `127.0.0.1:3000`. For Cloudflare Tunnel, route the public hostname to `http://control-plane:3000` and preserve WebSocket upgrades. The persisted canonical origin remains the public HTTPS hostname used for browser, API, callback, and webhook URLs.

## Cloudflare Tunnel

Cloudflare Tunnel can expose the entire control plane without opening an inbound Unraid port. Create a remotely managed tunnel and configure one public hostname with service:

```text
https://control.example.com/*  ->  http://control-plane:3000
```

This forwards `/`, `/api/*`, WebSockets, and `POST /api/github/webhooks` through the same tunnel. Put the tunnel token in `.env`:

```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

Start the control plane and tunnel profile:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml --profile tunnel up -d
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs -f cloudflared
```

Cloudflare terminates public HTTPS; the internal service remains HTTP. Enter `https://control.example.com` as the public origin during onboarding. Do not use `http://control-plane:3000` or a tunnel-specific hostname as the GitHub callback/webhook origin.

## GitHub webhook endpoint

Configure the GitHub App webhook URL as:

```text
https://<your-control-plane-origin>/api/github/webhooks
```

The endpoint accepts `POST` requests from GitHub, validates `X-Hub-Signature-256` with the encrypted webhook secret, and handles installation and `workflow_job` events. Do not expose a separate tunnel URL; use the persisted canonical control-plane origin.

## Unraid

Import `deploy/unraid/whitesmith-control-plane.xml`. Required inputs are the external `DATABASE_URL`, HTTP port, and persistent data mount. No GitHub credentials or master-key file are entered in the template.

## Upgrades and backups

Operators should back up PostgreSQL with `pg_dump` and the persistent data volume before upgrades. Keep the same data volume and database across image changes. Restore both together; do not regenerate `app_master_key`.

## Scope boundary

The image is built and smoke-tested for `linux/amd64`. This deployment contract does not claim end-to-end worker execution readiness for every worker runtime; those remain separate release gates.
