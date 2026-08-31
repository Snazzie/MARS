#!/usr/bin/env bash
set -euo pipefail

IMAGE=${IMAGE:?set IMAGE}
NETWORK="mars-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
POSTGRES="${NETWORK}-postgres"
CONTROL_PLANE="${NETWORK}-control-plane"
DATA_VOLUME="${NETWORK}-data"

cleanup() {
  docker rm -f "$CONTROL_PLANE" "$POSTGRES" >/dev/null 2>&1 || true
  docker volume rm "$DATA_VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_db() {
  local database=$1
  shift
  docker exec -i "$POSTGRES" psql -v ON_ERROR_STOP=1 -U mars -d "$database" "$@"
}

wait_ready() {
  local ready=''
  for attempt in {1..60}; do
    ready=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/readyz || true)
    if [[ "$ready" == 200 ]]; then return 0; fi
    sleep 2
  done
  docker logs "$CONTROL_PLANE" >&2
  echo 'control-plane failed readiness' >&2
  return 1
}

start_control_plane() {
  docker rm -f "$CONTROL_PLANE" >/dev/null 2>&1 || true
  docker run -d --name "$CONTROL_PLANE" --network "$NETWORK" \
    -e DATABASE_URL="postgres://mars:ci-only@${POSTGRES}:5432/$1" \
    -e PUBLIC_BASE_URL="http://127.0.0.1:3000" \
    -e GITHUB_WEBHOOK_URL="https://github.example.test" \
    -v "$DATA_VOLUME":/var/lib/mars \
    -p 127.0.0.1:3000:3000 \
    "$IMAGE" >/dev/null
  wait_ready
}

assert_release_artifacts() {
  for artifact in \
    /app/index.js \
    /app/web/index.html \
    /app/web/index.js \
    /app/web/index.css \
    /app/migrations/0000_mars_baseline.sql \
    /app/migrations/meta/_journal.json; do
    docker exec "$CONTROL_PLANE" test -f "$artifact"
  done
  if docker exec "$CONTROL_PLANE" test -e /app/workers; then
    echo "worker assets must not be packaged in the control-plane image" >&2
    return 1
  fi
}

seed_database() {
  local database=$1
  local baseline_hash
  baseline_hash=$(sha256sum packages/db/src/migrations/0000_mars_baseline.sql | cut -d ' ' -f1)
  psql_db postgres -c "CREATE DATABASE \"$database\"" >/dev/null
  psql_db "$database" < packages/db/src/migrations/0000_mars_baseline.sql >/dev/null
  psql_db "$database" -v baseline_hash="$baseline_hash" <<'SQL' >/dev/null
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id serial primary key,
  hash text not null,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations(hash, created_at)
SELECT :'baseline_hash', 1700000000000
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at=1700000000000
);
SQL
}

assert_converged_schema() {
  local database=$1
  local table_count column_count constraint_count
  table_count=$(psql_db "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='control_plane_config'")
  column_count=$(psql_db "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='github_discovery_checkpoints' AND column_name='completed_run_attempt') OR (table_name IN ('dashboard_runs','dashboard_jobs') AND column_name='run_attempt'))")
  constraint_count=$(psql_db "$database" -Atc "SELECT count(*) FROM pg_constraint WHERE conname IN ('github_discovery_checkpoints_completed_run_attempt_check','dashboard_runs_run_attempt_check','dashboard_jobs_run_attempt_check')")
  [[ "$table_count" == 1 && "$column_count" == 3 && "$constraint_count" == 3 ]]
}

docker network create "$NETWORK" >/dev/null
docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$POSTGRES" --network "$NETWORK" \
  -e POSTGRES_DB=mars \
  -e POSTGRES_USER=mars \
  -e POSTGRES_PASSWORD=ci-only \
  postgres:17-alpine >/dev/null

for attempt in {1..30}; do
  if docker exec "$POSTGRES" pg_isready -U mars -d mars >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'PostgreSQL did not become ready' >&2; exit 1; fi
  sleep 2
done

start_control_plane mars
assert_release_artifacts
printf '%s' "$(curl --silent --show-error --fail -X POST http://127.0.0.1:3000/api/setup/github-app \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: smoke-setup' \
  --data '{"publicBaseUrl":"http://127.0.0.1:3000"}')" \
  | bun -e 'const value=JSON.parse(await new Response(Bun.stdin).text()); if(typeof value.action!=="string"||typeof value.manifest!=="string") process.exit(1); console.log(JSON.stringify(value))'
echo 'control-plane live and ready'

docker rm -f "$CONTROL_PLANE" >/dev/null
start_control_plane mars
psql_db mars -Atc "SELECT public_base_url FROM control_plane_config WHERE singleton=true" | grep -Fx 'http://127.0.0.1:3000' >/dev/null
echo 'control-plane restart preserved setup state'

seed_database history_baseline
start_control_plane history_baseline
assert_converged_schema history_baseline
echo 'preseeded baseline schema converged'
