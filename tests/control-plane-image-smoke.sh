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
    -v "$DATA_VOLUME":/var/lib/mars \
    -p 127.0.0.1:3000:3000 \
    "$IMAGE" >/dev/null
  wait_ready
}

assert_release_artifacts() {
  for artifact in \
    /app/release-manifest.json \
    /app/workers/install-worker.sh \
    /app/workers/install-worker.ps1 \
    /app/workers/install-worker-macos.sh \
    /app/workers/linux-broker-compose.yaml \
    /app/workers/worker-domain.xml \
    /app/workers/mars-orchestrator \
    /app/workers/mars-orchestrator.exe \
    /app/workers/mars-orchestrator-macos-arm64 \
    /app/workers/mars-service-host.exe \
    /app/workers/build-windows-container-image-local.ps1 \
    /app/workers/verify-runtime.ps1 \
    /app/workers/Containerfile \
    /app/workers/entrypoint.ps1 \
    /app/workers/mars-job-agent.exe; do
    docker exec "$CONTROL_PLANE" test -f "$artifact"
  done
  docker exec "$CONTROL_PLANE" bun -e '
    const value=JSON.parse(await Bun.file("/app/release-manifest.json").text());
    const hash=/^[0-9a-f]{64}$/;
    const oci=/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[0-9]+)?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*@sha256:[0-9a-f]{64}$/;
    const https=(url)=>typeof url==="string"&&url.startsWith("https://");
    if(value.schemaVersion!==2||typeof value.buildId!=="string"||typeof value.contractVersion!=="string") process.exit(1);
    const platforms=value.platforms;
    for(const name of ["linux-x64","windows-x64","macos-arm64"]) if(!(name in platforms)) process.exit(1);
    if(platforms["linux-x64"]){
      const p=platforms["linux-x64"];
      if(!hash.test(p.orchestratorSha256)||!oci.test(p.brokerImage)||!https(p.goldenImageUrl)||!hash.test(p.goldenImageSha256)||!https(p.goldenCosignBundleUrl)||!hash.test(p.composeSha256)||!hash.test(p.domainTemplateSha256)) process.exit(1);
    }
    if(platforms["windows-x64"]){
      const p=platforms["windows-x64"], c=p.container;
      if(!hash.test(p.orchestratorSha256)||!hash.test(p.serviceHostSha256)||!https(p.vmTemplateUrl)||!hash.test(p.vmTemplateSha256)||!c||!oci.test(c.baseImage)) process.exit(1);
      for(const asset of [c.runner,c.git,c.vcRuntime]) if(!asset||!https(asset.url)||!hash.test(asset.sha256)) process.exit(1);
    }
    if(platforms["macos-arm64"]){
      const p=platforms["macos-arm64"];
      if(!hash.test(p.orchestratorSha256)||!oci.test(p.tartImage)||!hash.test(p.tartImageDigest)||p.tartImage!==p.tartImage.replace(/@.*/,"")+"@sha256:"+p.tartImageDigest) process.exit(1);
    }
    if(JSON.stringify(value).includes("__PLACEHOLDER__")) process.exit(1);
  '
}

seed_history() {
  local database=$1
  local branch=$2
  psql_db postgres -c "CREATE DATABASE \"$database\"" >/dev/null
  psql_db "$database" < packages/db/src/migrations/0000_legacy_baseline.sql >/dev/null
  psql_db "$database" < packages/db/src/migrations/0001_post_baseline.sql >/dev/null
  psql_db "$database" <<'SQL' >/dev/null
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('baseline', 1700000000000), ('post-baseline', 1700000001000), ('historical-branch', 1700000002000);
SQL
  if [[ "$branch" == run-attempt ]]; then
    psql_db "$database" < packages/db/src/migrations/0002_github_run_attempt.sql >/dev/null
  else
    psql_db "$database" <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS "control_plane_config" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "public_base_url" text,
  "setup_code_hash" bytea,
  "setup_completed_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "control_plane_config_singleton_check" CHECK (singleton)
);
SQL
  fi
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

for branch in run-attempt control-plane-config; do
  database="history_${branch//-/_}"
  seed_history "$database" "$branch"
  start_control_plane "$database"
  assert_converged_schema "$database"
  echo "historical $branch upgrade converged"
done
