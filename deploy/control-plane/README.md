# Mars Control Plane on Unraid

MARS (Managed Action Runner System) is the control plane for GitHub App
installation, administrator sign-in, worker enrollment, and pending-worker
configuration. This deployment runs the control plane in Docker on Unraid;
PostgreSQL and the public ingress are operator-managed.

## Deployment inputs

Use `PUBLIC_BASE_URL` as Mars's canonical browser origin. It may be
`http://localhost:3000` for local OAuth/browser access, or an HTTPS provider
hostname such as `https://example-name.ts.net` / custom domain such as
`https://control.example.com`. GitHub App homepage, OAuth callback, and setup
URLs use this origin. It is not required to be publicly reachable.

Set `GITHUB_WEBHOOK_URL` to a separate, required public HTTPS origin root that
GitHub can reach. Mars appends `/api/github/webhooks`; provide no path and do
not use localhost or private hosts. This may be the same as `PUBLIC_BASE_URL`
when that origin is public, or a distinct Cloudflare/Tailscale Funnel origin.
Do not use the local Unraid WebUI URL for the webhook origin.

`WORKER_BASE_URL` is optional and accepts one HTTPS origin for worker
connections. When omitted, workers use `PUBLIC_BASE_URL`. It is never used
for GitHub/browser URLs or webhook delivery.
Create `.env` with the external database and origin settings:

```bash
cat > .env <<'EOF'
DATABASE_URL=postgres://mars:password@db.example:5432/mars
PUBLIC_BASE_URL=http://localhost:3000
GITHUB_WEBHOOK_URL=https://control.example.com
# Optional private worker-only origin; defaults to PUBLIC_BASE_URL.
WORKER_BASE_URL=https://worker.example.com
EOF
```

The deployment template exposes only these operator inputs (plus the optional
tunnel token). Release artifact URLs, hashes, source paths, and image metadata
are maintainer-owned GitHub Actions inputs and must not be added to `.env`.
Keep `.env` and the tunnel token out of source control. The Compose HTTP
binding intentionally remains loopback-only at `127.0.0.1:3000`; ingress
connects to this service rather than exposing a new Unraid port.


## First boot and exact onboarding flow

Start PostgreSQL separately, then start the control plane:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml up -d control-plane
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs control-plane
```

Complete onboarding in this order:

1. Open the stable `PUBLIC_BASE_URL` in a browser and choose **Create GitHub
   App** on `/onboarding`.
2. Install the generated GitHub App in the intended account or organization.
   Return through the exact OAuth callback
   `https://<public-origin>/api/auth/github/callback` and sign in as the first
   administrator.
3. From the authenticated onboarding page, generate one worker bootstrap
   code, select the server-approved connection origin and platform, and copy
   the one-command handoff. Do not edit the generated command or reuse its
   show-once code.
4. Run that command on the supported worker host. The installer performs its
   preflight and prerequisite/artifact checkpoints, then enrolls the worker.
5. Wait for the worker to appear as an **online pending worker** in the
   onboarding page. Review its machine/VM identity and displayed signing
   fingerprint; compare it with the host identity before configuration.
6. Explicitly fingerprint/approve and configure the pending worker. Mars does
   not schedule work merely because enrollment succeeded.

The generated command is the primary worker handoff. Installer diagnostics
are retained at these paths:

| Platform | Persistent installer log | Persistent state |
| --- | --- | --- |
| Ubuntu Server 24.04 x64 | `/var/log/mars/install.log` | `/var/lib/mars/install-state.json` |
| Windows 11 Pro/Enterprise 24H2 x64 | `C:\\ProgramData\\Mars\\install.log` | `C:\\ProgramData\\Mars\\install-state.json` |
| macOS 14+ Apple Silicon | `~/Library/Application Support/Mars/install.log` | `~/Library/Application Support/Mars/install-state.json` |

A failed installer keeps its state for an idempotent retry. The protected join
code is retained only until enrollment authenticates; after the authenticated
worker WebSocket handshake it is removed.

## Health checks and persistence

- `GET /api/livez`
- `GET /api/readyz`
- `GET /api/healthz`

The `mars-data` volume contains control-plane data, including the generated
`app_master_key`. Back up the complete persistent data directory **together
with PostgreSQL** (for example, with `pg_dump`) before upgrades or migration.
Losing either the data volume or its matching database makes encrypted GitHub
credentials unrecoverable. Restore both as a pair; never regenerate
`app_master_key` for an existing database.

## Cloudflare named tunnel (public ingress)

A Cloudflare named tunnel can expose the entire stable hostname without an
inbound Unraid port. In Cloudflare Zero Trust, route the complete provider or
custom hostname to the control plane service:

```text
https://control.example.com/*  ->  http://control-plane:3000
```

Set `GITHUB_WEBHOOK_URL` to that public HTTPS origin root (or another public
ingress), without `/api/github/webhooks`; Mars appends the path itself. The
route must forward all paths and permit WebSocket upgrades for both
`/api/browser/invalidations` and `/api/v1/workers/connect`. Preserve webhook
headers/body (including `X-Hub-Signature-256`) and bypass Cloudflare
Access/identity challenges for webhook, GitHub callback, and worker
bootstrap/WebSocket requests. Keep TLS termination at Cloudflare; the internal
Compose hop remains HTTP.

Put the named tunnel token in `.env` and start the tunnel profile:

```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
docker compose --env-file .env -f deploy/control-plane/compose.yaml --profile tunnel up -d
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs -f cloudflared
```

Do not use `http://control-plane:3000` or a tunnel-internal hostname for
`GITHUB_WEBHOOK_URL`. `PUBLIC_BASE_URL` may remain `http://localhost:3000`
when only local browser access is needed.

On the Unraid host, use **Tailscale Serve** for a private worker
connection. Set `WORKER_BASE_URL` to its HTTPS origin; leave it empty when
workers can reach Mars through `PUBLIC_BASE_URL`. Serve is a worker connection
origin and must never be used for `GITHUB_WEBHOOK_URL`.

For GitHub webhook delivery, use **Tailscale Funnel** (or Cloudflare/another
public ingress) and set `GITHUB_WEBHOOK_URL` to its stable public HTTPS origin
root. Mars appends `/api/github/webhooks`. GitHub App setup and reconciliation
polling do not require Funnel when webhook delivery is not enabled, but this
variable is still required at control-plane startup. Do not run a privileged
Tailscale container; operate Tailscale on the Unraid host or use external
ingress.

## GitHub URLs and origin changes

The GitHub App uses these paths:

```text
Homepage:  <PUBLIC_BASE_URL>/
Callback:  <PUBLIC_BASE_URL>/api/auth/github/callback
Setup:     <PUBLIC_BASE_URL>/api/github/app/setup
Webhook:   <GITHUB_WEBHOOK_URL>/api/github/webhooks
```

The manifest enables webhook delivery at the explicit `GITHUB_WEBHOOK_URL`;
reconciliation polling remains enabled as a complementary recovery mechanism.

Changing `PUBLIC_BASE_URL` changes Mars's effective browser origin immediately
at the next process startup. Changing `GITHUB_WEBHOOK_URL` changes the
manifest's webhook destination. During the same maintenance window, update
the existing GitHub App homepage, OAuth callback
`/api/auth/github/callback`, setup `/api/github/app/setup`, and webhook
`/api/github/webhooks` URLs to match the corresponding environment values.
Keep the old ingress available until GitHub settings and the control-plane
deployment agree; otherwise sign-in, App installation, or webhook delivery
can fail.

## Unraid

Import `deploy/unraid/mars-control-plane.xml`. Keep the local Unraid WebUI URL
for initial container access and health checks. Supply the external
`DATABASE_URL`, persistent data path, canonical `PUBLIC_BASE_URL` (which may
be `http://localhost:3000` for local browser OAuth), required public HTTPS
`GITHUB_WEBHOOK_URL`, and optional `WORKER_BASE_URL`. The worker origin is a
single value and defaults to the public origin when omitted. The template is
unprivileged and preserves the loopback Compose port.
## Worker release boundary

The control-plane image is published as
`ghcr.io/snazzie/mars/control-plane:latest`. Copied commands and installer
metadata resolve the current worker release through GitHub's stable endpoint:
`https://github.com/Snazzie/Mars/releases/latest/download/<asset>`. The
platform asset names are `install-worker-linux-x64.sh`,
`install-worker-windows-x64.ps1`, and `install-worker-macos-arm64.sh`.

The control-plane image packages the small runtime artifacts for all supported
platforms: Linux x64 (linux/amd64) installer, compose/domain files and orchestrator; Windows
x64 installer, orchestrator, service host and container build inputs; and
Apple-Silicon macOS installer and orchestrator. Large VM/Tart/golden-image and
broker assets remain immutable HTTPS/OCI references in the worker release
manifest. A platform with unavailable manifest data is reported unavailable;
it is never silently substituted with another platform.
The worker execution runtimes remain outside the Unraid control-plane container.

Supported host targets are Ubuntu Server 24.04 x64, Windows 11 Pro/Enterprise
24H2 x64, and macOS 14+ arm64. Their release gates require real KVM,
Hyper-V, and Tart support respectively; source-only or unsupported-host tests
do not claim installation readiness.

## Upgrades and backups

Before an upgrade, back up PostgreSQL and the complete `mars-data` volume as a
coordinated pair. Keep `app_master_key`, `DATABASE_URL`, and the database
contents together. Restore the same key and data volume before starting a new
image; do not delete the volume or regenerate the key.
