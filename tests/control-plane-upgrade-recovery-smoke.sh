#!/usr/bin/env bash
set -euo pipefail

: "${PREVIOUS_IMAGE:?set PREVIOUS_IMAGE}"
: "${CANDIDATE_IMAGE:?set CANDIDATE_IMAGE}"
: "${EXPECTED_BUILD_SHA:?set EXPECTED_BUILD_SHA}"
for image in "$PREVIOUS_IMAGE" "$CANDIDATE_IMAGE"; do
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || { echo 'recovery images must be immutable repository@sha256 references' >&2; exit 1; }
done
PROJECT="mars-recovery-${GITHUB_RUN_ID:-local}-${RANDOM}"
RESTORE_PROJECT="${PROJECT}-restore"
BACKUP_DIR=$(mktemp -d)
compose=(docker compose -p "$PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml)
restore_compose=(docker compose -p "$RESTORE_PROJECT" -f deploy/control-plane/compose.yaml -f tests/fixtures/control-plane-compose-smoke.override.yaml)
cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; "${restore_compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$BACKUP_DIR"; }
trap cleanup EXIT
export DATABASE_URL=postgres://mars:ci-only@postgres:5432/mars
export PUBLIC_BASE_URL=http://127.0.0.1:3000
export GITHUB_WEBHOOK_URL=https://hooks.example.test
export MARS_CONTROL_PLANE_IMAGE="$PREVIOUS_IMAGE"
"${compose[@]}" up -d --wait control-plane
postgres_port=$("${compose[@]}" port postgres 5432 | cut -d: -f2)
HOST_DATABASE_URL="postgres://mars:ci-only@127.0.0.1:${postgres_port}/mars"
curl --fail --silent --show-error -X POST http://127.0.0.1:3000/api/setup/github-app -H 'content-type: application/json' -H 'idempotency-key: recovery-setup' --data '{"publicBaseUrl":"http://127.0.0.1:3000"}' >/dev/null
# This helper uses the real generated DATA_ROOT/app_master_key and SecretBox; it never prints secrets.
DATA_ROOT=$(docker volume inspect "${PROJECT}_mars-data" --format '{{.Mountpoint}}') DATABASE_URL="$HOST_DATABASE_URL" bun run tests/control-plane-recovery-fixture.ts --seed
postgres=$("${compose[@]}" ps -q postgres)
docker exec "$postgres" pg_dump --format=custom --no-owner --no-acl -U mars mars > "$BACKUP_DIR/pre-upgrade.dump"
docker run --rm -v "${PROJECT}_mars-data:/data:ro" -v "$BACKUP_DIR:/backup" alpine:3.20 tar -C /data -czf /backup/pre-upgrade-data.tar.gz .
(cd "$BACKUP_DIR" && sha256sum pre-upgrade.dump pre-upgrade-data.tar.gz > checksums.txt)
"${compose[@]}" stop control-plane
export MARS_CONTROL_PLANE_IMAGE="$CANDIDATE_IMAGE"
"${compose[@]}" up -d --wait control-plane
health=$(curl --fail --silent --show-error http://127.0.0.1:3000/api/healthz); printf '%s' "$health" | EXPECTED_BUILD_SHA="$EXPECTED_BUILD_SHA" bun -e 'const v=JSON.parse(await new Response(Bun.stdin).text()); if(v.buildId!==Bun.env.EXPECTED_BUILD_SHA) throw new Error("candidate build identity mismatch")'
DATA_ROOT=$(docker volume inspect "${PROJECT}_mars-data" --format '{{.Mountpoint}}') DATABASE_URL="$HOST_DATABASE_URL" bun run tests/control-plane-recovery-fixture.ts --read
"${compose[@]}" restart control-plane >/dev/null
"${compose[@]}" up -d --wait control-plane >/dev/null
# Rollback is supported only with the coordinated pre-upgrade database and DATA_ROOT pair.
"${compose[@]}" stop control-plane
docker cp "$BACKUP_DIR/pre-upgrade.dump" "$postgres:/tmp/pre-upgrade.dump"
docker exec "$postgres" psql -U mars -d postgres -c 'DROP DATABASE IF EXISTS mars'
docker exec "$postgres" psql -U mars -d postgres -c 'CREATE DATABASE mars OWNER mars'
docker exec "$postgres" pg_restore --clean --if-exists --no-owner --no-acl -U mars -d mars /tmp/pre-upgrade.dump
docker run --rm -v "${PROJECT}_mars-data:/data" alpine:3.20 sh -c 'rm -rf /data/* /data/.[!.]* /data/..?*'
docker run --rm -v "${PROJECT}_mars-data:/data" -v "$BACKUP_DIR:/backup:ro" alpine:3.20 tar -C /data -xzf /backup/pre-upgrade-data.tar.gz
export MARS_CONTROL_PLANE_IMAGE="$PREVIOUS_IMAGE"
"${compose[@]}" up -d --wait control-plane
DATA_ROOT=$(docker volume inspect "${PROJECT}_mars-data" --format '{{.Mountpoint}}') DATABASE_URL="$HOST_DATABASE_URL" bun run tests/control-plane-recovery-fixture.ts --read
# Restore into fresh PostgreSQL and DATA_ROOT volumes with the candidate digest.
"${restore_compose[@]}" up -d --wait postgres
restore_postgres=$("${restore_compose[@]}" ps -q postgres)
restore_port=$("${restore_compose[@]}" port postgres 5432 | cut -d: -f2)
RESTORE_DATABASE_URL="postgres://mars:ci-only@127.0.0.1:${restore_port}/mars"
docker cp "$BACKUP_DIR/pre-upgrade.dump" "$restore_postgres:/tmp/pre-upgrade.dump"
docker exec "$restore_postgres" pg_restore --clean --if-exists --no-owner --no-acl -U mars -d mars /tmp/pre-upgrade.dump
docker run --rm -v "${RESTORE_PROJECT}_mars-data:/data" -v "$BACKUP_DIR:/backup:ro" alpine:3.20 tar -C /data -xzf /backup/pre-upgrade-data.tar.gz
export MARS_CONTROL_PLANE_IMAGE="$CANDIDATE_IMAGE"
"${restore_compose[@]}" up -d --wait control-plane
restore_health=$(curl --fail --silent --show-error http://127.0.0.1:3000/api/healthz); printf '%s' "$restore_health" | EXPECTED_BUILD_SHA="$EXPECTED_BUILD_SHA" bun -e 'const v=JSON.parse(await new Response(Bun.stdin).text()); if(v.buildId!==Bun.env.EXPECTED_BUILD_SHA) throw new Error("clean restore build identity mismatch")'
DATA_ROOT=$(docker volume inspect "${RESTORE_PROJECT}_mars-data" --format '{{.Mountpoint}}') DATABASE_URL="$RESTORE_DATABASE_URL" bun run tests/control-plane-recovery-fixture.ts --read
printf '%s\n' 'PASS coordinated upgrade, restart, encrypted configuration recovery, exact previous-digest rollback, and clean candidate restore'
