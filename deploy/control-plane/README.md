# Mars Control Plane on Unraid

MARS (Managed Action Runner System) is the control plane for GitHub App
installation, administrator sign-in, worker enrollment, and pending-worker
configuration. This deployment runs the API and web dashboard in Docker on
Unraid. PostgreSQL and public ingress are operator-managed outside the
container; use an external PostgreSQL 17 server.

The released image targets **Linux/amd64** (`linux/amd64`). It contains only the API, web
assets, database migrations, and production runtime. Worker installers,
binaries, VM images, broker files, domain templates, and worker manifests are
not copied into the image.

## Deployment inputs

Set `PUBLIC_BASE_URL` to Mars's canonical browser origin. It may be
`http://localhost:3000` for local OAuth/browser access, or an HTTPS provider
hostname such as `https://example-name.ts.net` / custom domain such as
`https://control.example.com`. GitHub App homepage, OAuth callback, and setup
URLs use this origin. It is not required to be publicly reachable.

Set `GITHUB_WEBHOOK_URL` to a separate, required public HTTPS origin root that
GitHub can reach. Mars appends `/api/github/webhooks`; provide no path and do
not use localhost or private hosts. It may be the same as `PUBLIC_BASE_URL`
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

The Unraid template exposes only the HTTP port, appdata path, external
database URL, and these origins. Release artifact URLs, hashes, source paths,
image metadata, and worker contract settings are maintainer-owned release
inputs; do not add them to `.env` or the template.

## External PostgreSQL 17

PostgreSQL is intentionally not bundled in this deployment. Use an external
PostgreSQL 17 server and give the `DATABASE_URL` account permission to connect
to the maintenance database `postgres`. On first start the account must be
able to create the target database if it is absent, or the target database may
be pre-created and owned by that account. The control plane applies pending migrations at startup; do not manually copy migration files into the data volume.

For a pre-created database, grant the account ownership (or equivalent schema
and table privileges) before starting the image. Verify DNS, TLS/firewall
rules, and the database URL from the Unraid host. The image does not start a
PostgreSQL service and does not manage PostgreSQL credentials.

## Worker release boundary

The control-plane image owns its worker release contract. Release builds bake
an exact
`https://github.com/Snazzie/Mars/releases/download/worker-v<worker-version>/worker-release-manifest.json`
URL and the worker contract version from
`deploy/workers/contract-version.txt` into the image. At startup the API
fetches that immutable manifest, validates its schema and hashes, requires a
non-null Linux release, and checks contract compatibility. Every installer
asset is fetched from the same immutable worker release and verified before it
is served. A missing, unreachable, or mismatched asset fails closed with the
structured artifact-unavailable response.

Do not override the baked worker manifest or contract settings in Unraid or
Compose. Publish the worker release before deploying or restarting its
compatible control-plane image. Worker execution remains external to Unraid:
Linux uses the broker/KVM host flow, Windows uses the container runtime, and
macOS prepares a local Tart base on the Apple-Silicon host. A Windows VM setup
is not claimed by this release.

GHCR packages must be publicly readable for an Unraid host to pull the image
anonymously. No registry credentials belong in the template. For an upgrade,
pin Compose to the published application tag (for example,
`ghcr.io/snazzie/mars/control-plane:v0.0.1`) after checking the matching
worker release; the Unraid template intentionally follows
`ghcr.io/snazzie/mars/control-plane:latest`. To roll back, stop the service,
restore the prior application tag, and keep the compatible worker release and
data/database pair together. Never use a mutable worker `releases/latest`
URL.

## Compose and Unraid networking

`deploy/control-plane/compose.yaml` binds `127.0.0.1:3000:3000` deliberately.
Use a reverse proxy or the tunnel profile for ingress; local Compose does not
publish a LAN port directly. The Unraid XML is different by design: it uses
Docker `bridge` mode and maps host port 3000, so the WebUI is LAN-published at
`http://<unraid-host>:3000/`. Both surfaces use the same external PostgreSQL
and image-owned worker contract.

Start the Compose service after PostgreSQL is reachable:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml up -d control-plane
docker compose --env-file .env -f deploy/control-plane/compose.yaml ps
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs control-plane
```

An optional Cloudflare named tunnel can expose the stable hostname without an
inbound Unraid port. Put its token in an untracked `.env` and start the tunnel
profile. Route every path to `http://control-plane:3000`, permit WebSocket
upgrades for `/api/browser/invalidations` and `/api/v1/workers/connect`,
preserve webhook headers/body (including `X-Hub-Signature-256`), and bypass
Cloudflare Access/identity challenges for webhook, GitHub callback, and
worker bootstrap/WebSocket requests. Keep TLS termination at Cloudflare and
the internal Compose hop on HTTP.

```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
docker compose --env-file .env -f deploy/control-plane/compose.yaml --profile tunnel up -d
docker compose --env-file .env -f deploy/control-plane/compose.yaml logs -f cloudflared
```

Do not use `http://control-plane:3000` or a tunnel-internal hostname for
`GITHUB_WEBHOOK_URL`. For private worker connections, Tailscale Serve may
provide the `WORKER_BASE_URL`; use Tailscale Funnel (or Cloudflare/another
public ingress) for GitHub webhook delivery. Do not run a privileged Tailscale
container.

## First boot and onboarding

1. Open `PUBLIC_BASE_URL` and choose **Create GitHub App** on `/onboarding`.
2. Install the generated GitHub App in the intended account or organization.
   Return through `/api/auth/github/callback` and sign in as the first
   administrator.
3. Generate one worker bootstrap code, select the server-approved connection
   origin and platform, and copy the one-command handoff. Do not edit the
   generated command or reuse its show-once code.
4. Run that command on the supported worker host. The installer performs
   prerequisite and artifact checkpoints, then enrolls the worker.
5. Wait for an **online pending worker**. Review its machine/VM identity and
   displayed signing fingerprint against the host identity.
6. Explicitly fingerprint/approve and configure the pending worker. Enrollment
   alone does not schedule work.

Installer diagnostics are retained at these paths:

| Platform | Persistent installer log | Persistent state |
| --- | --- | --- |
| Ubuntu Server 24.04 x64 | `/var/log/mars/install.log` | `/var/lib/mars/install-state.json` |
| Windows 11 Pro/Enterprise 24H2 x64 | `C:\\ProgramData\\Mars\\install.log` | `C:\\ProgramData\\Mars\\install-state.json` |
| macOS 14+ Apple Silicon | `~/Library/Application Support/Mars/install.log` | `~/Library/Application Support/Mars/install-state.json` |

A failed installer keeps state for an idempotent retry. The protected join
code is retained only until enrollment authenticates; after the authenticated
worker WebSocket handshake it is removed.

## Health, diagnostics, and persistence

The image healthcheck requests `http://127.0.0.1:3000/api/readyz` every 10
seconds, with a 3-second timeout, 60-second start period, and 6 retries. Check
all three endpoints from the host or through the configured ingress:

```bash
curl --fail http://127.0.0.1:3000/api/livez
curl --fail http://127.0.0.1:3000/api/readyz
curl --fail http://127.0.0.1:3000/api/healthz
CONTROL_PLANE_ID="$(docker compose --env-file .env -f deploy/control-plane/compose.yaml ps -q control-plane)"
docker inspect --format '{{json .State.Health}}' "$CONTROL_PLANE_ID"
docker logs "$CONTROL_PLANE_ID"
```

Compose generates the container name from the project directory, so use its
reported ID rather than assuming a fixed name. For an Unraid-managed
container, find the Docker-assigned ID/name from the running image and use
that value for inspection and logs:

```bash
docker ps --filter ancestor=ghcr.io/snazzie/mars/control-plane:latest --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
docker inspect --format '{{json .State.Health}}' <container-id-or-name>
docker logs <container-id-or-name>
```

The first-start diagnostic sequence is: confirm the image pulled anonymously,
check PostgreSQL reachability/permissions and `DATABASE_URL`, inspect
`/api/readyz` and container logs, then check public URL and webhook routing.
A readiness failure must not be hidden by restarting repeatedly.

The `mars-data` volume (or Unraid appdata bind at
`/mnt/user/appdata/mars-control-plane/data`) contains control-plane data,
including the generated `app_master_key`. Back up the complete persistent
data directory **together with PostgreSQL** (for example with `pg_dump`) before
upgrades or migrations. Losing either the data volume or its matching database
makes encrypted GitHub credentials unrecoverable. Restore PostgreSQL and
`/mnt/user/appdata/mars-control-plane/data`, including `app_master_key`, as a
coordinated pair; never regenerate the key for an existing database.

## GitHub URLs and origin changes

The GitHub App uses these paths:

```text
Homepage:  <PUBLIC_BASE_URL>/
Callback:  <PUBLIC_BASE_URL>/api/auth/github/callback
Setup:     <PUBLIC_BASE_URL>/api/github/app/setup
Webhook:   <GITHUB_WEBHOOK_URL>/api/github/webhooks
```

Changing either origin takes effect at the next process startup. During the
same maintenance window, update the existing GitHub App homepage, OAuth
callback, setup, and webhook URLs to match. Keep the old ingress available
until GitHub settings and the control-plane deployment agree; otherwise
sign-in, App installation, or webhook delivery can fail.

## Unraid

Import `deploy/unraid/mars-control-plane.xml`. Supply the external PostgreSQL
17 `DATABASE_URL`, persistent appdata path, canonical `PUBLIC_BASE_URL`,
required public HTTPS `GITHUB_WEBHOOK_URL`, and optional `WORKER_BASE_URL`.
The template is unprivileged, targets Linux/amd64, keeps PostgreSQL external,
and publishes host port 3000 in bridge mode. It intentionally has no worker
manifest or worker contract inputs because those values belong to the
released image.
