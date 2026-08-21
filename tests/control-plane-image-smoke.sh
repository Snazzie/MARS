#!/usr/bin/env bash
set -euo pipefail

IMAGE=${IMAGE:?set IMAGE}
NETWORK="whitesmith-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
POSTGRES="${NETWORK}-postgres"
CONTROL_PLANE="${NETWORK}-control-plane"
DATA_VOLUME="${NETWORK}-data"

cleanup() {
  docker rm -f "$CONTROL_PLANE" "$POSTGRES" >/dev/null 2>&1 || true
  docker volume rm "$DATA_VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NETWORK" >/dev/null
docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$POSTGRES" --network "$NETWORK" \
  -e POSTGRES_DB=whitesmith \
  -e POSTGRES_USER=whitesmith \
  -e POSTGRES_PASSWORD=ci-only \
  postgres:17-alpine >/dev/null

for attempt in {1..30}; do
  if docker exec "$POSTGRES" pg_isready -U whitesmith -d whitesmith >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'PostgreSQL did not become ready' >&2; exit 1; fi
  sleep 2
done

docker run -d --name "$CONTROL_PLANE" --network "$NETWORK" \
  -e DATABASE_URL=postgres://whitesmith:ci-only@${POSTGRES}:5432/whitesmith \
  -v "$DATA_VOLUME":/var/lib/whitesmith \
  -p 127.0.0.1:3000:3000 \
  "$IMAGE" >/dev/null

for attempt in {1..60}; do
  live=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/livez || true)
  ready=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/readyz || true)
  if [[ "$live" == 200 && "$ready" == 200 ]]; then break; fi
  sleep 2
done
if [[ "$live" != 200 || "$ready" != 200 ]]; then
  echo 'control-plane failed readiness' >&2
  docker logs "$CONTROL_PLANE" >&2
  exit 1
fi
echo 'control-plane live and ready'

status=$(curl --silent --show-error http://127.0.0.1:3000/api/onboarding/status)
printf '%s' "$status" | bun -e 'const value=JSON.parse(await new Response(Bun.stdin).text()); if(value.step!=="setup") process.exit(1)'
setup_code=$(docker logs "$CONTROL_PLANE" 2>&1 | sed -n 's/.*Whitesmith first-run setup code: //p' | tail -n 1)
[[ ${#setup_code} -ge 32 ]]
manifest=$(curl --silent --show-error --fail -X POST http://127.0.0.1:3000/api/setup/github-app \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-setup' \
  --data "{\"setupCode\":\"$setup_code\",\"publicBaseUrl\":\"http://127.0.0.1:3000\"}")
printf '%s' "$manifest" | bun -e 'const value=JSON.parse(await new Response(Bun.stdin).text()); if(typeof value.action!=="string"||typeof value.manifest!=="string") process.exit(1)'
printf '%s\n' "$manifest"

docker rm -f "$CONTROL_PLANE" >/dev/null
docker run -d --name "$CONTROL_PLANE" --network "$NETWORK" \
  -e DATABASE_URL=postgres://whitesmith:ci-only@${POSTGRES}:5432/whitesmith \
  -v "$DATA_VOLUME":/var/lib/whitesmith \
  -p 127.0.0.1:3000:3000 \
  "$IMAGE" >/dev/null
for attempt in {1..60}; do
  ready=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/readyz || true)
  if [[ "$ready" == 200 ]]; then break; fi
  sleep 2
done
[[ "$ready" == 200 ]]
status=$(curl --silent --show-error http://127.0.0.1:3000/api/onboarding/status)
printf '%s' "$status" | bun -e 'const value=JSON.parse(await new Response(Bun.stdin).text()); if(value.step!=="setup") process.exit(1)'
