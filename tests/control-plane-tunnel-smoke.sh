#!/usr/bin/env bash
set -euo pipefail

: "${MARS_CONTROL_PLANE_IMAGE:?set MARS_CONTROL_PLANE_IMAGE}"
: "${EXPECTED_BUILD_SHA:?set EXPECTED_BUILD_SHA}"
[[ "$MARS_CONTROL_PLANE_IMAGE" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || { echo 'MARS_CONTROL_PLANE_IMAGE must be repository@sha256:<64 hex>' >&2; exit 1; }
PROJECT="mars-tunnel-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
OVERRIDE=$(mktemp)
cleanup() {
  docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml -f "$OVERRIDE" --profile tunnel down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$OVERRIDE"
}
trap cleanup EXIT
cat >"$OVERRIDE" <<'YAML'
services:
  cloudflared:
    entrypoint: ["cloudflared"]
    command: ["tunnel", "--no-autoupdate", "--url", "http://control-plane:3000"]
YAML
export MARS_CONTROL_PLANE_IMAGE
export DATABASE_URL=postgres://mars:ci-only@postgres:5432/mars
export PUBLIC_BASE_URL=http://127.0.0.1:3000
export GITHUB_WEBHOOK_URL=https://hooks.example.test
export WORKER_BASE_URL=
export CLOUDFLARE_TUNNEL_TOKEN=quick-tunnel-smoke-placeholder

docker pull --platform linux/amd64 "$MARS_CONTROL_PLANE_IMAGE"
docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml -f "$OVERRIDE" --profile tunnel up -d --wait control-plane cloudflared

url=""
for _ in $(seq 1 30); do
  logs=$(docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml -f "$OVERRIDE" logs cloudflared 2>/dev/null || true)
  url=$(printf '%s' "$logs" | bun -e 'const text=await new Response(Bun.stdin).text(); process.stdout.write(text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "")')
  [[ -n "$url" ]] && break
  sleep 2
done
[[ -n "$url" ]] || { echo 'Cloudflare Quick Tunnel URL was not emitted' >&2; exit 1; }

ready=$(curl --fail --silent --show-error --retry 10 --retry-delay 2 "$url/api/readyz")
printf '%s' "$ready" | EXPECTED_BUILD_SHA="$EXPECTED_BUILD_SHA" bun -e 'const value=JSON.parse(await new Response(Bun.stdin).text()); if(value.ok !== true || value.checks?.database !== true) throw new Error("tunnel readiness failed"); if(value.buildId !== Bun.env.EXPECTED_BUILD_SHA) throw new Error(`health buildId mismatch: ${value.buildId}`)'
printf '%s\n' 'PASS Docker control plane plus Cloudflared sidecar reached /api/readyz through a temporary HTTPS tunnel'
