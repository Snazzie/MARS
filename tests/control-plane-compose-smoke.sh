#!/usr/bin/env bash
set -euo pipefail

: "${MARS_CONTROL_PLANE_IMAGE:?set MARS_CONTROL_PLANE_IMAGE}"
: "${EXPECTED_BUILD_SHA:?set EXPECTED_BUILD_SHA}"
[[ "$MARS_CONTROL_PLANE_IMAGE" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || { echo 'MARS_CONTROL_PLANE_IMAGE must be repository@sha256:<64 hex>' >&2; exit 1; }
PROJECT="mars-compose-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
DOCKER_CONFIG_DIR=$(mktemp -d)
DATA_ROOT=$(mktemp -d)
cleanup() {
  docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DOCKER_CONFIG_DIR" "$DATA_ROOT"
}
trap cleanup EXIT
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"
export MARS_CONTROL_PLANE_IMAGE
export DATABASE_URL=postgres://mars:ci-only@postgres:5432/mars
export PUBLIC_BASE_URL=http://127.0.0.1:3000
export GITHUB_WEBHOOK_URL=https://hooks.example.test
export WORKER_BASE_URL=

docker pull --platform linux/amd64 "$MARS_CONTROL_PLANE_IMAGE"
docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml up -d --wait control-plane
for endpoint in /api/livez /api/readyz /api/healthz / /index.js /index.css; do
  curl --fail --silent --show-error "http://127.0.0.1:3000$endpoint" >/dev/null
done
health=$(curl --fail --silent --show-error http://127.0.0.1:3000/api/healthz)
printf '%s' "$health" | EXPECTED_BUILD_SHA="$EXPECTED_BUILD_SHA" bun -e 'const value=JSON.parse(await new Response(Bun.stdin).text()); if(value.buildId !== Bun.env.EXPECTED_BUILD_SHA) throw new Error(`health buildId mismatch: ${value.buildId}`)'
inspect=$(docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml ps -q control-plane)
[[ "$(docker inspect --format '{{.Config.User}}' "$inspect")" != 0 ]] || { echo 'control plane must not run as root' >&2; exit 1; }
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$inspect")" == true ]] || { echo 'control plane root filesystem must be read-only' >&2; exit 1; }
invalid=$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/github/webhooks -H 'content-type: application/json' -H 'x-hub-signature-256: sha256=invalid' -H 'x-github-delivery: compose-invalid' -H 'x-github-event: ping' --data '{}')
[[ "$invalid" == 401 ]] || { echo "invalid webhook status: $invalid" >&2; exit 1; }
setup=$(curl --fail --silent --show-error -X POST http://127.0.0.1:3000/api/setup/github-app -H 'content-type: application/json' -H 'idempotency-key: compose-setup' --data '{"publicBaseUrl":"http://127.0.0.1:3000"}')
printf '%s' "$setup" | bun -e 'const value=JSON.parse(await new Response(Bun.stdin).text()); if(typeof value.manifest !== "string" || typeof value.action !== "string") throw new Error("setup state was not persisted")'
docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml restart control-plane >/dev/null
docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml up -d --wait control-plane >/dev/null
COMPOSE_BASE_URL=http://127.0.0.1:3000 EXPECTED_BUILD_SHA="$EXPECTED_BUILD_SHA" bun run tests/proxied-control-plane-smoke.ts
printf '%s\n' 'PASS anonymous amd64 digest pull, external PostgreSQL 17, health, dashboard, read-only runtime, and ingress gates'
