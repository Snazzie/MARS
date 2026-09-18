#!/usr/bin/env bash
set -euo pipefail
: "${MARS_CONTROL_PLANE_IMAGE:?set MARS_CONTROL_PLANE_IMAGE}"
: "${EXPECTED_BUILD_SHA:?set EXPECTED_BUILD_SHA}"
[[ "$MARS_CONTROL_PLANE_IMAGE" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || { echo 'MARS_CONTROL_PLANE_IMAGE must be immutable' >&2; exit 1; }
project="mars-unraid-smoke-${RANDOM}"
postgres="${project}-postgres"
control="${project}-control"
postgres_data=$(mktemp -d)
mars_data=$(mktemp -d)
cleanup() { docker rm -f "$control" "$postgres" "${project}-wrong" >/dev/null 2>&1 || true; rm -rf "$postgres_data" "$mars_data"; }
trap cleanup EXIT
password=ci-only
# Unraid-equivalent: bridge networking, published PostgreSQL/MARS ports, and bind-backed data roots.
docker run -d --name "$postgres" --network bridge -p 127.0.0.1::5432 -e POSTGRES_DB=mars -e POSTGRES_USER=mars -e POSTGRES_PASSWORD="$password" -v "$postgres_data:/var/lib/postgresql/data" postgres:17 >/dev/null
postgres_port=''; for _ in {1..60}; do postgres_port=$(docker port "$postgres" 5432/tcp | sed 's/.*://') || true; [[ -n "$postgres_port" ]] && docker exec "$postgres" pg_isready -U mars -d mars >/dev/null 2>&1 && break; sleep 2; done
[[ -n "$postgres_port" ]] || { docker logs "$postgres"; exit 1; }
docker run -d --name "$control" --network bridge --add-host host.docker.internal:host-gateway -p 127.0.0.1::3000 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m -v "$mars_data:/var/lib/mars" -e DATABASE_URL="postgres://mars:$password@host.docker.internal:$postgres_port/mars" -e DATA_ROOT=/var/lib/mars -e PUBLIC_BASE_URL=http://127.0.0.1:3000 -e GITHUB_WEBHOOK_URL=https://hooks.example.test "$MARS_CONTROL_PLANE_IMAGE" >/dev/null
control_port=''; for _ in {1..90}; do control_port=$(docker port "$control" 3000/tcp | sed 's/.*://') || true; [[ -n "$control_port" ]] && curl --fail --silent "http://127.0.0.1:$control_port/api/readyz" >/dev/null && break; sleep 2; done
[[ -n "$control_port" ]] || { docker logs "$control"; exit 1; }
for endpoint in /api/livez /api/readyz /api/healthz / /index.js /index.css; do curl --fail --silent "http://127.0.0.1:$control_port$endpoint" >/dev/null; done
health=$(curl --fail --silent "http://127.0.0.1:$control_port/api/healthz")
printf '%s' "$health" | EXPECTED_BUILD_SHA="$EXPECTED_BUILD_SHA" bun -e 'const v=JSON.parse(await new Response(Bun.stdin).text()); if(v.buildId!==Bun.env.EXPECTED_BUILD_SHA) throw new Error("build identity mismatch")'
[[ "$(docker inspect --format '{{.Config.User}}' "$control")" != 0 ]]
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$control")" == true ]]
test -s "$mars_data/app_master_key"
docker restart "$control" >/dev/null
for _ in {1..60}; do curl --fail --silent "http://127.0.0.1:$control_port/api/readyz" >/dev/null && break; sleep 2; done
# Incorrect credentials must fail closed rather than serving a partially initialized API.
docker run --name "${project}-wrong" --network bridge --add-host host.docker.internal:host-gateway --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m -v "$mars_data:/var/lib/mars" -e DATABASE_URL="postgres://mars:wrong@host.docker.internal:$postgres_port/mars" -e DATA_ROOT=/var/lib/mars -e PUBLIC_BASE_URL=http://127.0.0.1:3000 -e GITHUB_WEBHOOK_URL=https://hooks.example.test "$MARS_CONTROL_PLANE_IMAGE" >/dev/null 2>&1 && { echo 'incorrect database credentials unexpectedly started' >&2; exit 1; } || true
printf '%s\n' 'PASS direct bridge PostgreSQL/MARS containers, migrations, health, non-root read-only runtime, persistence, and credential failure'
