# Control Plane Docker Deployment

This directory contains the Linux/amd64 control-plane image and PostgreSQL-only Compose stack. PostgreSQL is external to this core file; Cloudflare Tunnel and ingress are operator-managed.

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

Read the one-time setup code from the stable `Whitesmith first-run setup code: ` log line. Open `/onboarding`, enter that code, and enter the externally reachable HTTPS origin. The setup flow creates the GitHub App, then redirects to GitHub for the first administrator sign-in.

The control plane persists the generated encryption key at `${DATA_ROOT}/app_master_key` in the named `whitesmith-data` volume. Operators should back up that file together with PostgreSQL. Losing either side makes encrypted GitHub credentials unrecoverable.

## Health checks

- `GET /api/livez`
- `GET /api/readyz`
- `GET /api/healthz`

The Compose binding is loopback-only at `127.0.0.1:3000`; place an HTTPS reverse proxy or separately managed tunnel in front of it. Preserve WebSocket upgrades. Production uses the persisted canonical origin for browser, API, callback, and webhook URLs.

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
