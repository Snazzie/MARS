#!/usr/bin/env bash
set -euo pipefail

IMAGE=${IMAGE:?set IMAGE}
SMOKE_MANIFEST_URL="${SMOKE_MANIFEST_URL-}"
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
  local manifest_args=()
  local runtime_args=()
  if [[ -n "${SMOKE_NODE_ENV:-}" ]]; then
    runtime_args+=(-e "NODE_ENV=$SMOKE_NODE_ENV")
  fi
  if [[ -n "$SMOKE_MANIFEST_URL" ]]; then
    manifest_args+=(-e "MARS_WORKER_RELEASE_MANIFEST_URL=$SMOKE_MANIFEST_URL")
  fi
  docker run -d --name "$CONTROL_PLANE" --network "$NETWORK" \
    -e DATABASE_URL="postgres://mars:ci-only@${POSTGRES}:5432/$1" \
    -e PUBLIC_BASE_URL="http://127.0.0.1:3000" \
    -e GITHUB_WEBHOOK_URL="https://github.example.test" \
    "${runtime_args[@]}" \
    "${manifest_args[@]}" \
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
    /app/migrations/0000_colossal_storm.sql \
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
  baseline_hash=$(sha256sum packages/db/src/migrations/0000_colossal_storm.sql | cut -d ' ' -f1)
  psql_db postgres -c "CREATE DATABASE \"$database\"" >/dev/null
  psql_db "$database" < packages/db/src/migrations/0000_colossal_storm.sql >/dev/null
  psql_db "$database" -v baseline_hash="$baseline_hash" <<'SQL' >/dev/null
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id serial primary key,
  hash text not null,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations(hash, created_at)
SELECT :'baseline_hash', 1789492017398
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at=1789492017398
);
SQL
}

seed_timing_snapshot_drift() {
  psql_db history_baseline <<'SQL' >/dev/null
INSERT INTO organizations (id, github_org_id, login)
VALUES ('00000000-0000-0000-0000-000000000001', 1001, 'smoke-org');
INSERT INTO dashboard_installations (id, organization_id, github_installation_id)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 2002);
INSERT INTO dashboard_repositories (id, organization_id, installation_id, github_repository_id, name, full_name)
VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 3003, 'smoke-repo', 'smoke-org/smoke-repo');
INSERT INTO dashboard_runs (id, organization_id, repository_id, github_run_id, run_number, workflow_name, event, branch, commit_sha, actor_login, status, queued_at)
VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 4004, 1, 'smoke', 'push', 'main', 'deadbeef', 'smoke', 'completed', now());
INSERT INTO dashboard_jobs (id, organization_id, run_id, github_job_id, name, status, stage, requested)
VALUES ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004', 5005, 'smoke', 'completed', 'smoke', '{}');
INSERT INTO workers (id, name, platform, admission_state)
VALUES ('00000000-0000-0000-0000-000000000006', 'smoke-worker', 'linux', 'adopted');
INSERT INTO runner_pools (id, organization_id, worker_id, name, platform, driver, image_digest, resources, labels, enabled)
VALUES ('00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000006', 'smoke-pool', 'linux', 'docker', 'sha256:smoke', '{}', '{}', true);
INSERT INTO runner_leases (id, organization_id, pool_id, worker_id, routing_key, github_job_id, state, requested, nonce, expires_at)
VALUES ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000006', 'smoke', 5005, 'completed', '{}', 'smoke', now());
INSERT INTO dashboard_job_timing_snapshots (organization_id, job_id, run_id, repository_id, github_job_id, repository_name, workflow_name, job_name, worker_id, platform, driver, outcome, completed_at, queued_at, queue_duration_ms, startup_duration_ms, execution_duration_ms, cleanup_duration_ms, total_duration_ms, requested_vcpu, requested_memory_bytes, requested_storage_bytes, requested_concurrency, effective_concurrency)
VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 5005, 'smoke-repo', 'smoke', 'smoke', '00000000-0000-0000-0000-000000000006', 'linux', 'docker', 'success', now(), now(), 0, 0, 1, 0, 1, 1, 1, 1, 1, 1);
DROP INDEX dashboard_job_timing_worker_idx;
ALTER TABLE dashboard_job_timing_snapshots DROP COLUMN worker_id;
SQL
}

assert_converged_schema() {
  local database=$1
  local table_count column_count constraint_count worker_id_nullability worker_index snapshot_worker_id
  table_count=$(psql_db "$database" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='control_plane_config'")
  column_count=$(psql_db "$database" -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='github_discovery_checkpoints' AND column_name='completed_run_attempt') OR (table_name IN ('dashboard_runs','dashboard_jobs') AND column_name='run_attempt'))")
  constraint_count=$(psql_db "$database" -Atc "SELECT count(*) FROM pg_constraint WHERE conname IN ('github_discovery_checkpoints_completed_run_attempt_check','dashboard_runs_run_attempt_check','dashboard_jobs_run_attempt_check')")
  worker_id_nullability=$(psql_db "$database" -Atc "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='dashboard_job_timing_snapshots' AND column_name='worker_id'")
  worker_index=$(psql_db "$database" -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='dashboard_job_timing_worker_idx'")
  snapshot_worker_id=$(psql_db "$database" -Atc "SELECT worker_id FROM dashboard_job_timing_snapshots WHERE job_id='00000000-0000-0000-0000-000000000005'")
  [[ "$table_count" == 1 && "$column_count" == 3 && "$constraint_count" == 3 ]]
  [[ "$worker_id_nullability" == "NO" && "$worker_index" == 1 ]]
  [[ "$snapshot_worker_id" == "00000000-0000-0000-0000-000000000006" ]]
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
seed_timing_snapshot_drift
start_control_plane history_baseline
assert_converged_schema history_baseline
echo 'preseeded baseline schema converged'
