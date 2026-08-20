#!/usr/bin/env bash
set -euo pipefail

IMAGE=${IMAGE:?set IMAGE}
NETWORK="whitesmith-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
POSTGRES="${NETWORK}-postgres"
CONTROL_PLANE="${NETWORK}-control-plane"
MASTER_KEY="$(mktemp)"

cleanup() {
  docker rm -f "$CONTROL_PLANE" "$POSTGRES" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$MASTER_KEY"
}
trap cleanup EXIT

printf 'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=' > "$MASTER_KEY"
chmod 644 "$MASTER_KEY"
docker network create "$NETWORK" >/dev/null
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
  -e NODE_ENV=production \
  -e WHITESMITH_BUILD_ID=ci-smoke \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -e BROWSER_BASE_URL=http://localhost:3000 \
  -e DATABASE_URL=postgres://whitesmith:ci-only@${POSTGRES}:5432/whitesmith \
  -e BOOTSTRAP_GITHUB_LOGIN=ci \
  -e GITHUB_OAUTH_CLIENT_ID=ci \
  -e GITHUB_OAUTH_CLIENT_SECRET=ci \
  -e GITHUB_WEBHOOK_SECRET=ci \
  -e WHITESMITH_WINDOWS_CONTAINER_BASE_IMAGE=mcr.microsoft.com/windows/servercore:ltsc2025@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -e WHITESMITH_WINDOWS_CONTAINER_RUNNER_URL=https://example.invalid/runner.zip \
  -e WHITESMITH_WINDOWS_CONTAINER_RUNNER_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -e WHITESMITH_WINDOWS_CONTAINER_GIT_URL=https://example.invalid/git.zip \
  -e WHITESMITH_WINDOWS_CONTAINER_GIT_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  -e WHITESMITH_WINDOWS_CONTAINER_VC_URL=https://example.invalid/vc.exe \
  -e WHITESMITH_WINDOWS_CONTAINER_VC_SHA256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  -e APP_MASTER_KEY_FILE=/run/secrets/app_master_key \
  --mount "type=bind,src=$MASTER_KEY,dst=/run/secrets/app_master_key,readonly" \
  -p 127.0.0.1:3000:3000 \
  "$IMAGE" >/dev/null

for attempt in {1..60}; do
  live=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/livez || true)
  ready=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/readyz || true)
  if [[ "$live" == 200 && "$ready" == 200 ]]; then
    echo 'control-plane live and ready'
    exit 0
  fi
  sleep 2
done

echo 'control-plane failed readiness' >&2
docker logs "$CONTROL_PLANE" >&2
exit 1
