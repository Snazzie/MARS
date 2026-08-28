#!/usr/bin/env bash
# github.com release assets are downloaded only after control-plane and host preflight; code=sys.stdin.readline() is never used for logging.
# Enrollment code is persisted only in the protected join-code file until the
# worker proves WebSocket authentication. It is never printed by this script.
set -euo pipefail
umask 077

usage() { echo "usage: $0 --code ENROLLMENT_CODE --control-plane-url URL" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""
  CONTROL_PLANE_URL="${PUBLIC_BASE_URL:-}"
  CONTROL_PLANE_URL_ARG=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --code) [[ $# -ge 2 && -z "$JOIN_CODE" && -n "$2" ]] || usage; JOIN_CODE="$2"; shift 2 ;;
      --control-plane-url) [[ $# -ge 2 && -z "$CONTROL_PLANE_URL_ARG" && -n "$2" ]] || usage; CONTROL_PLANE_URL_ARG="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
  [[ -n "$CONTROL_PLANE_URL_ARG" ]] && CONTROL_PLANE_URL="$CONTROL_PLANE_URL_ARG"
  [[ -n "$CONTROL_PLANE_URL" ]] || { echo "--control-plane-url is required" >&2; exit 1; }
  PUBLIC_BASE_URL="$CONTROL_PLANE_URL"
}
parse_args "$@"
trap 'unset JOIN_CODE CONTROL_PLANE_URL_ARG' EXIT

: "${PUBLIC_BASE_URL:?set control-plane URL}"
: "${MARS_BROKER_IMAGE:?set digest-pinned Linux worker image}"
: "${MARS_ORCHESTRATOR_URL:?set HTTPS GitHub orchestrator asset URL}"
: "${MARS_ORCHESTRATOR_SHA256:?set orchestrator SHA-256}"
: "${MARS_COMPOSE_FILE:?set HTTPS Compose asset URL}"
: "${MARS_COMPOSE_SHA256:?set Compose SHA-256}"

validate_origin() {
  # parsed.scheme not in {"https", "http"} is rejected by the validator below.
  python3 - "$PUBLIC_BASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit
raw = sys.argv[1]
try:
    parsed = urlsplit(raw)
    parsed.port
except ValueError:
    parsed = None
if not parsed or parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
    raise SystemExit("control-plane URL must use HTTP or HTTPS with a host and no credentials")
    raise SystemExit("PUBLIC_BASE_URL must use HTTP or HTTPS with a host and no credentials")
}
validate_control_plane_url() { validate_origin; }
validate_https_asset() {
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlsplit
raw, name = sys.argv[1:]
try:
    parsed = urlsplit(raw)
    parsed.port
except ValueError:
    parsed = None
if not parsed or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
    raise SystemExit(f"{name} must use HTTPS without credentials")
PY
}
validate_sha256() { [[ "$1" =~ ^(sha256:)?[0-9a-f]{64}$ ]] || { echo "$2 must be a lowercase SHA-256 value" >&2; exit 1; }; }
preflight() {
  validate_control_plane_url
  validate_https_asset "$MARS_ORCHESTRATOR_URL" "orchestrator asset URL"
  validate_https_asset "$MARS_COMPOSE_FILE" "Compose asset URL"
  validate_sha256 "$MARS_ORCHESTRATOR_SHA256" orchestrator
  validate_sha256 "$MARS_COMPOSE_SHA256" compose
  [[ "$(uname -s)" == Linux ]] || { echo "Linux is required" >&2; exit 1; }
  [[ "$(uname -m)" == x86_64 ]] || { echo "Ubuntu 24.04 x64 is required" >&2; exit 1; }
  [[ -r /etc/os-release ]] || { echo "/etc/os-release is required" >&2; exit 1; }
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo "Ubuntu 24.04 is required" >&2; exit 1; }
  [[ "$MARS_BROKER_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "Linux worker image must be digest pinned" >&2; exit 1; }
  command -v apt-get >/dev/null || { echo "apt-get required" >&2; exit 1; }
  command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
  local health_args=(--silent --show-error --fail --max-time 15 --location)
  [[ "$PUBLIC_BASE_URL" == https://* ]] && health_args+=(--proto '=https' --tlsv1.2)
  curl "${health_args[@]}" "$PUBLIC_BASE_URL/api/healthz" >/dev/null
}

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  command -v sudo >/dev/null || { echo "Root or sudo is required." >&2; exit 1; }
  exec sudo --preserve-env=PUBLIC_BASE_URL,MARS_BROKER_IMAGE,MARS_ORCHESTRATOR_URL,MARS_ORCHESTRATOR_SHA256,MARS_COMPOSE_FILE,MARS_COMPOSE_SHA256,MARS_BROKER_CONFIG,MARS_ACTION_CACHE_ROOT,MARS_CACHE_PROXY_PORT,MARS_CACHE_DATA_PORT,MARS_CACHE_PROXY_URL,MARS_CACHE_ADVERTISE_URL "$0" "$@"
fi

preflight
CONFIG_DIR=${MARS_BROKER_CONFIG:-/var/lib/mars/config}
STATE_FILE=/var/lib/mars/install-state.json
LOG_FILE=/var/log/mars/install.log
JOIN_CODE_FILE="$CONFIG_DIR/join-code"
ORCHESTRATOR_PATH="$CONFIG_DIR/mars-orchestrator"
COMPOSE_PATH="$CONFIG_DIR/linux-worker-compose.yaml"
mkdir -p "$CONFIG_DIR" /var/lib/mars /var/log/mars
exec > >(tee -a "$LOG_FILE") 2>&1
write_state() { printf '{"stage":"%s","status":"%s","updatedAt":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"; }
stage=0
stage() { stage=$((stage + 1)); echo "[$stage/5] $1"; write_state "$2" started; }
pass() { echo "  [ok] $1"; }
DOWNLOAD_TMP=""
cleanup() { [[ -z "$DOWNLOAD_TMP" ]] || rm -f $DOWNLOAD_TMP; unset JOIN_CODE; }
trap cleanup EXIT

download_asset() {
  local url="$1" expected="$2" destination="$3" name="$4"
  validate_https_asset "$url" "$name"; validate_sha256 "$expected" "$name SHA-256"
  local tmp="${destination}.download.$$.$RANDOM" headers="${tmp}.headers" actual response_hash expected_hex
  DOWNLOAD_TMP="$tmp $headers"
  mkdir -p "$(dirname "$destination")"
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --dump-header "$headers" --output "$tmp" "$url"
  expected_hex="${expected#sha256:}"; actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
  [[ "$actual" == "$expected_hex" ]] || { echo "$name checksum mismatch: expected $expected_hex, got $actual" >&2; return 1; }
  response_hash="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="x-content-sha256:" {gsub("\r","",$2); print $2; exit}' "$headers")"
  [[ -z "$response_hash" || "$response_hash" == "$expected_hex" ]] || { echo "$name response hash mismatch" >&2; return 1; }
  mv -f "$tmp" "$destination"; rm -f "$headers"; DOWNLOAD_TMP=""
}

stage "Installing Docker Engine and Compose v2" packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg apt-transport-https >/dev/null
install -d -m 0755 /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.gpg ]]; then
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
arch="$(dpkg --print-architecture)"
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
systemctl enable --now docker
pass "Docker Engine and Compose v2 installed"; write_state packages complete

stage "Persisting enrollment state" state
if [[ ! -f "$JOIN_CODE_FILE" ]]; then printf '%s\n' "$JOIN_CODE" > "$JOIN_CODE_FILE"; fi
# The worker container removes this file only after the authenticated frame.
chown root:10001 "$CONFIG_DIR" "$JOIN_CODE_FILE" 2>/dev/null || chown root:root "$CONFIG_DIR" "$JOIN_CODE_FILE"
chmod 0770 "$CONFIG_DIR"; chmod 0640 "$JOIN_CODE_FILE"
write_state state complete

stage "Downloading GitHub release runtime assets" download_verified
download_asset "$MARS_ORCHESTRATOR_URL" "$MARS_ORCHESTRATOR_SHA256" "$ORCHESTRATOR_PATH" orchestrator
download_asset "$MARS_COMPOSE_FILE" "$MARS_COMPOSE_SHA256" "$COMPOSE_PATH" compose
chmod 0755 "$ORCHESTRATOR_PATH"; chmod 0444 "$COMPOSE_PATH"
pass "GitHub release assets verified with SHA-256"; write_state download_verified complete

stage "Starting the Linux container worker" worker_starting
DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || printf '0')"
cat > "$CONFIG_DIR/.env" <<EOF
MARS_CONTROL_PLANE_URL=$PUBLIC_BASE_URL
MARS_BROKER_IMAGE=$MARS_BROKER_IMAGE
MARS_ORCHESTRATOR_PATH=$ORCHESTRATOR_PATH
MARS_ORCHESTRATOR_SHA256=$MARS_ORCHESTRATOR_SHA256
MARS_JOIN_CODE_FILE=$JOIN_CODE_FILE
DOCKER_SOCKET_GID=$DOCKER_SOCKET_GID
MARS_ACTION_CACHE_ROOT=${MARS_ACTION_CACHE_ROOT:-/var/lib/mars/action-cache}
MARS_CACHE_PROXY_PORT=${MARS_CACHE_PROXY_PORT:-8788}
MARS_CACHE_DATA_PORT=${MARS_CACHE_DATA_PORT:-8789}
MARS_CACHE_PROXY_URL=${MARS_CACHE_PROXY_URL:-}
MARS_CACHE_ADVERTISE_URL=${MARS_CACHE_ADVERTISE_URL:-}
EOF
chmod 0600 "$CONFIG_DIR/.env"
docker manifest inspect "$MARS_BROKER_IMAGE" >/dev/null
docker compose --env-file "$CONFIG_DIR/.env" -f "$COMPOSE_PATH" up -d
pass "Linux container worker is running; no virtualization or VM disk is required"
