# Mars Control Plane on Unraid

Mars (Managed Action Runner(s)) is the control plane for GitHub App
installation, administrator sign-in, worker enrollment, and pending-worker
configuration. This deployment runs the control plane in Docker on Unraid;
PostgreSQL and the public ingress are operator-managed.

## Deployment inputs

Use a stable **public HTTPS origin** for `PUBLIC_BASE_URL`. It may be a
provider-assigned hostname such as `https://example-name.ts.net` or a custom
domain such as `https://control.example.com`. This is the browser and GitHub
origin: GitHub App homepage, OAuth callback, and setup URL use it. Mars creates
the GitHub App without a webhook during onboarding; GitHub webhook delivery is
optional and can be enabled later after a publicly reachable HTTPS endpoint is
available. Do not use the local Unraid WebUI URL as this origin.

`WORKER_BASE_URL` is optional and accepts one HTTPS origin for worker
connections. When omitted, workers use `PUBLIC_BASE_URL`. It is never used
for GitHub/browser URLs.


Create `.env` with the external database and origin settings:

```bash
cat > .env <<'EOF'
DATABASE_URL=postgres://mars:password@db.example:5432/mars
PUBLIC_BASE_URL=https://control.example.com
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

## Cloudflare named tunnel (public origin)

A Cloudflare named tunnel can expose the entire stable hostname without an
inbound Unraid port. In Cloudflare Zero Trust, route the complete provider or
custom hostname to the control plane service:

```text
https://control.example.com/*  ->  http://control-plane:3000
```

The route must forward all paths and permit WebSocket upgrades for both
`/api/browser/invalidations` and `/api/v1/workers/connect`. If GitHub webhooks
are enabled later, preserve the original webhook headers and request body
(including `X-Hub-Signature-256`) and bypass Cloudflare Access/identity
challenges for that endpoint. Also bypass identity challenges for GitHub
callbacks and worker bootstrap/WebSocket requests. Keep TLS termination at
Cloudflare; the internal Compose hop remains HTTP.

Put the named tunnel token in `.env` and start the tunnel profile:

```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
docker compose --env-file .env -f deploy/control-plane/compose.yaml --profile tunnel up -d
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs -f cloudflared
```

Do not use `http://control-plane:3000` or a tunnel-internal hostname in GitHub
settings. The public origin remains the canonical browser/GitHub origin.

## Tailscale Serve and Funnel

On the Unraid host, use **Tailscale Serve** for a private worker
connection. Set `WORKER_BASE_URL` to its HTTPS origin; leave it empty when
workers can reach Mars through `PUBLIC_BASE_URL`. Serve is a worker connection
origin, not a required GitHub origin.

GitHub App setup and reconciliation polling do not require Tailscale Funnel,
Cloudflare, or any webhook ingress. If webhook delivery is enabled later, use
**Tailscale Funnel** (or Cloudflare/another public ingress) for a publicly
reachable HTTPS webhook URL. Do not run a privileged Tailscale container;
install and operate Tailscale on the Unraid host or use an external ingress.

## GitHub URLs and origin changes

The GitHub App uses these paths on the current public origin:

```text
Homepage:  https://<public-origin>/
Callback:  https://<public-origin>/api/auth/github/callback
Setup:     https://<public-origin>/api/github/app/setup
```

Mars creates the App without webhook configuration and uses reconciliation
polling for GitHub state. An administrator may add the webhook later from the
GitHub App settings; that URL must be publicly reachable over HTTPS and point
to `/api/github/webhooks`.

Changing `PUBLIC_BASE_URL` changes Mars's effective origin immediately at the
next process startup. During the same maintenance window, update the existing
GitHub App homepage, OAuth callback
`/api/auth/github/callback`, and setup `/api/github/app/setup` URLs to the new
origin. If a webhook was enabled, update `/api/github/webhooks` too. Keep the
old ingress available until those GitHub settings and the control-plane
deployment agree; otherwise sign-in or App installation can fail.

## Unraid

Import `deploy/unraid/mars-control-plane.xml`. Keep the local Unraid WebUI URL
for initial container access and health checks; it is not the public GitHub
origin. Supply the external `DATABASE_URL`, persistent data path, required
public HTTPS `PUBLIC_BASE_URL`, and optional `WORKER_BASE_URL`. The worker
origin is a single value and defaults to the public origin when omitted. The
template is unprivileged and preserves the loopback Compose port.

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
