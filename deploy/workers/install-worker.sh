#!/usr/bin/env bash
# code=sys.stdin.readline() is intentionally not persisted in process output; protected join-code state is persisted below.
set -euo pipefail
umask 077

usage() { echo "usage: $0 --code ENROLLMENT_CODE [--control-plane-url URL]" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""
  CONTROL_PLANE_URL="${PUBLIC_BASE_URL:-}"
  CONTROL_PLANE_URL_ARG=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --code)
        [[ $# -ge 2 && -z "$JOIN_CODE" && -n "$2" ]] || usage
        JOIN_CODE="$2"
        shift 2
        ;;
      --control-plane-url)
        [[ $# -ge 2 && -z "$CONTROL_PLANE_URL_ARG" && -n "$2" ]] || usage
        CONTROL_PLANE_URL_ARG="$2"
        shift 2
        ;;
      *) usage ;;
    esac
  done
  [[ -n "$JOIN_CODE" && "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
  if [[ -n "$CONTROL_PLANE_URL_ARG" ]]; then
    CONTROL_PLANE_URL="$CONTROL_PLANE_URL_ARG"
  fi
  PUBLIC_BASE_URL="$CONTROL_PLANE_URL"
}
parse_args "$@"
trap 'unset JOIN_CODE CONTROL_PLANE_URL_ARG' EXIT

require_config() {
  [[ -n "${PUBLIC_BASE_URL:-}" ]] || { echo 'PUBLIC_BASE_URL is required' >&2; exit 1; }
  [[ -n "${MARS_ARTIFACT_MODE:-}" ]] || { echo 'MARS_ARTIFACT_MODE is required' >&2; exit 1; }
  [[ -n "${MARS_BROKER_IMAGE:-}" ]] || { echo 'MARS_BROKER_IMAGE is required' >&2; exit 1; }
  [[ -n "${MARS_GOLDEN_IMAGE:-}" ]] || { echo 'MARS_GOLDEN_IMAGE is required' >&2; exit 1; }
  [[ -n "${MARS_GOLDEN_DIGEST:-}" ]] || { echo 'MARS_GOLDEN_DIGEST is required' >&2; exit 1; }
  [[ -n "${MARS_COMPOSE_FILE:-}" ]] || { echo 'MARS_COMPOSE_FILE is required' >&2; exit 1; }
  [[ -n "${MARS_COMPOSE_SHA256:-}" ]] || { echo 'MARS_COMPOSE_SHA256 is required' >&2; exit 1; }
  [[ -n "${MARS_DOMAIN_TEMPLATE:-}" ]] || { echo 'MARS_DOMAIN_TEMPLATE is required' >&2; exit 1; }
  [[ -n "${MARS_DOMAIN_TEMPLATE_SHA256:-}" ]] || { echo 'MARS_DOMAIN_TEMPLATE_SHA256 is required' >&2; exit 1; }
}
validate_url() {
  python3 - "$1" "$2" "$3" "${4:-$PUBLIC_BASE_URL}" <<'PY'
import ipaddress
import os
import sys
from urllib.parse import urlsplit

raw, name, kind, base_url = sys.argv[1:]
mode = os.environ.get("MARS_ARTIFACT_MODE")

def parse_http_url(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or "#" in value
    ):
        return None
    if port is not None and not 1 <= port <= 65535:
        return None
    return parsed

def origin(parsed):
    host = parsed.hostname
    try:
        host = ipaddress.ip_address(host).compressed
    except ValueError:
        host = host.lower()
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, host, port

parsed = parse_http_url(raw)
if parsed is None:
    raise SystemExit(f"{name} must use HTTP(S) without credentials or fragments")
if kind == "origin" and (parsed.path not in {"", "/"} or "?" in raw):
    raise SystemExit(f"{name} must be an HTTP(S) origin without a path, query, credentials, or fragment")
if mode == "production" and parsed.scheme != "https":
    raise SystemExit(f"{name} must use HTTPS in production")
if mode == "local" and kind == "asset":
    base = parse_http_url(base_url)
    if base is None or origin(parsed) != origin(base):
        raise SystemExit(f"{name} must use the same origin as PUBLIC_BASE_URL in local mode")
PY
}
validate_sha256() { [[ "$1" =~ ^(sha256:)?[0-9a-f]{64}$ ]] || { echo "$2 must be a lowercase SHA-256 value" >&2; exit 1; }; }
validate_config() {
  require_config
  [[ "$MARS_ARTIFACT_MODE" == local || "$MARS_ARTIFACT_MODE" == production ]] || { echo 'MARS_ARTIFACT_MODE must be local or production' >&2; exit 1; }
  command -v python3 >/dev/null || { echo 'python3 required' >&2; exit 1; }
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"
  validate_url "$PUBLIC_BASE_URL" "PUBLIC_BASE_URL" origin
  validate_url "$MARS_GOLDEN_IMAGE" "MARS_GOLDEN_IMAGE" asset
  validate_url "$MARS_COMPOSE_FILE" "MARS_COMPOSE_FILE" asset
  validate_url "$MARS_DOMAIN_TEMPLATE" "MARS_DOMAIN_TEMPLATE" asset
  validate_sha256 "$MARS_GOLDEN_DIGEST" "MARS_GOLDEN_DIGEST"
  validate_sha256 "$MARS_COMPOSE_SHA256" "MARS_COMPOSE_SHA256"
  validate_sha256 "$MARS_DOMAIN_TEMPLATE_SHA256" "MARS_DOMAIN_TEMPLATE_SHA256"
  if [[ "$MARS_ARTIFACT_MODE" == production ]]; then
    [[ "$MARS_BROKER_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo 'MARS_BROKER_IMAGE must be digest-pinned in production' >&2; exit 1; }
  fi
}
validate_download_url() { validate_url "$1" "$2" asset; }

preflight() {
  [[ "$(uname -s)" == Linux ]] || { echo 'Linux is required' >&2; exit 1; }
  [[ "$(uname -m)" == x86_64 ]] || { echo 'Ubuntu 24.04 x64 is required' >&2; exit 1; }
  [[ -r /etc/os-release ]] || { echo '/etc/os-release is required' >&2; exit 1; }
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo 'Ubuntu 24.04 is required' >&2; exit 1; }
  command -v apt-get >/dev/null || { echo 'apt-get required' >&2; exit 1; }
  command -v curl >/dev/null || { echo 'curl required' >&2; exit 1; }
  local local_http=false
  [[ "$PUBLIC_BASE_URL" == http://* ]] && local_http=true
  if [[ "$local_http" == true ]]; then
    curl --silent --show-error --fail --max-time 15 --location "$PUBLIC_BASE_URL/api/healthz" >/dev/null
  else
    curl --silent --show-error --fail --max-time 15 --location --proto '=https' --tlsv1.2 "$PUBLIC_BASE_URL/api/healthz" >/dev/null
  fi
}
validate_config

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  command -v sudo >/dev/null || { echo 'Root or sudo is required.' >&2; exit 1; }
  exec sudo --preserve-env=PUBLIC_BASE_URL,MARS_ARTIFACT_MODE,MARS_BROKER_IMAGE,MARS_GOLDEN_IMAGE,MARS_GOLDEN_DIGEST,MARS_COMPOSE_FILE,MARS_COMPOSE_SHA256,MARS_DOMAIN_TEMPLATE,MARS_DOMAIN_TEMPLATE_SHA256,MARS_BROKER_CONFIG,MARS_LIBVIRT_NETWORK,MARS_ACTION_CACHE_ROOT,MARS_CACHE_PROXY_PORT,MARS_CACHE_DATA_PORT,MARS_CACHE_PROXY_URL,MARS_CACHE_ADVERTISE_URL,MARS_CACHE_TOKEN_ISSUER,MARS_CACHE_JWKS_URL "$0" "$@"
fi

check_kvm_access() {
  grep -Eq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo || { echo 'hardware virtualization is required' >&2; exit 1; }
  [[ -e /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || { echo '/dev/kvm is required and must be readable/writable' >&2; exit 1; }
}

check_kvm_access
preflight
CONFIG_DIR=${MARS_BROKER_CONFIG:-/var/lib/mars}
STATE_FILE=/var/lib/mars/install-state.json
LOG_FILE=/var/log/mars/install.log
JOIN_CODE_FILE="$CONFIG_DIR/join-code"
mkdir -p "$CONFIG_DIR" /var/lib/mars /var/log/mars
exec > >(tee -a "$LOG_FILE") 2>&1
write_state() {
  local stage="$1" status="$2"
  printf '{"stage":"%s","status":"%s","updatedAt":"%s"}\n' "$stage" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
}
stage=0
stage() { stage=$((stage + 1)); echo "[$stage/8] $1"; write_state "$2" started; }
pass() { echo "  [ok] $1"; }
DOWNLOAD_TMP=""
cleanup() {
  if [[ -n "$DOWNLOAD_TMP" ]]; then for path in $DOWNLOAD_TMP; do rm -f "$path"; done; fi
  unset JOIN_CODE
}
trap cleanup EXIT

stage 'Installing host prerequisites' packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg apt-transport-https libvirt-daemon-system libvirt-clients qemu-kvm qemu-utils >/dev/null
if [[ ! -s /etc/apt/keyrings/docker.gpg ]]; then
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
arch="$(dpkg --print-architecture)"
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
pass 'Docker Engine, Compose v2, libvirt, QEMU, and curl installed'
write_state packages complete

stage 'Enabling virtualization services and default NAT network' virtualization
systemctl enable --now libvirtd
systemctl enable --now docker
if ! virsh net-info default >/dev/null 2>&1; then
  virsh net-define /usr/share/libvirt/networks/default.xml >/dev/null
fi
virsh net-autostart default >/dev/null
virsh net-start default >/dev/null 2>&1 || true
[[ -S /var/run/libvirt/libvirt-sock ]] || { echo 'libvirt socket required' >&2; exit 1; }
network_name=${MARS_LIBVIRT_NETWORK:-default}
network_info="$(virsh net-info "$network_name")"
case "$network_info" in *"Active:              yes"*) ;; *) echo 'configured libvirt network must be active' >&2; exit 1 ;; esac
pass 'libvirtd, Docker, and the default NAT network are active'
write_state virtualization complete

stage 'Persisting enrollment state' state
if [[ ! -f "$JOIN_CODE_FILE" ]]; then
  printf '%s\n' "$JOIN_CODE" > "$JOIN_CODE_FILE"
fi
# The broker runs as UID/GID 10001. Keep the credential private to that
# service group while allowing it to read and unlink the file after auth.
chown root:10001 "$CONFIG_DIR" "$JOIN_CODE_FILE"
chmod 0770 "$CONFIG_DIR"
chmod 0640 "$JOIN_CODE_FILE"
write_state state complete

download_asset() {
  local url="$1" expected="$2" destination="$3" name="$4"
  validate_download_url "$url" "$name"; validate_sha256 "$expected" "$name SHA-256"
  local parent tmp headers actual response_hash expected_hex
  local -a security=(--silent --show-error --fail --location)
  [[ "$url" == https://* ]] && security+=(--proto '=https' --tlsv1.2)
  parent="$(dirname "$destination")"; mkdir -p "$parent"; tmp="${destination}.download.$$.$RANDOM"; headers="${tmp}.headers"; DOWNLOAD_TMP="$tmp $headers"
  curl "${security[@]}" --dump-header "$headers" --output "$tmp" "$url"
  expected_hex="${expected#sha256:}"; actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
  [[ "$actual" == "$expected_hex" ]] || { echo "$name checksum mismatch: expected $expected_hex, got $actual" >&2; return 1; }
  response_hash="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="x-content-sha256:" {gsub("\r","",$2); print $2; exit}' "$headers")"
  [[ -z "$response_hash" || "$response_hash" == "$expected_hex" ]] || { echo "$name response hash mismatch" >&2; return 1; }
  mv -f "$tmp" "$destination"; rm -f "$headers"; DOWNLOAD_TMP=""
}

stage 'Downloading and verifying immutable worker assets' download_verified
GOLDEN_ROOT=${MARS_GOLDEN_ROOT:-$CONFIG_DIR/golden}; GOLDEN_PATH="$GOLDEN_ROOT/worker.qcow2"; COMPOSE_PATH="$CONFIG_DIR/linux-broker-compose.yaml"; DOMAIN_PATH="$CONFIG_DIR/worker-domain.xml"
download_asset "$MARS_GOLDEN_IMAGE" "$MARS_GOLDEN_DIGEST" "$GOLDEN_PATH" 'golden image'
download_asset "$MARS_COMPOSE_FILE" "$MARS_COMPOSE_SHA256" "$COMPOSE_PATH" compose
download_asset "$MARS_DOMAIN_TEMPLATE" "$MARS_DOMAIN_TEMPLATE_SHA256" "$DOMAIN_PATH" 'domain template'
chmod 0444 "$GOLDEN_PATH"; pass 'Hashes and broker metadata verified'; write_state download_verified complete

stage 'Writing broker configuration' configuration
mkdir -p "$GOLDEN_ROOT" "${MARS_CLONE_ROOT:-$CONFIG_DIR/clones}" "${MARS_CHANNEL_ROOT:-$CONFIG_DIR/channels}"
cat > "$CONFIG_DIR/.env" <<EOF
MARS_CONTROL_PLANE_URL=$PUBLIC_BASE_URL
MARS_BROKER_IMAGE=$MARS_BROKER_IMAGE
MARS_GOLDEN_DIGEST=$MARS_GOLDEN_DIGEST
MARS_BROKER_CONFIG=$CONFIG_DIR
MARS_GOLDEN_ROOT=$GOLDEN_ROOT
MARS_DOMAIN_TEMPLATE=$DOMAIN_PATH
MARS_CLONE_ROOT=${MARS_CLONE_ROOT:-$CONFIG_DIR/clones}
MARS_CHANNEL_ROOT=${MARS_CHANNEL_ROOT:-$CONFIG_DIR/channels}
MARS_JOIN_CODE_FILE=$JOIN_CODE_FILE
MARS_LIBVIRT_NETWORK=$network_name
LIBVIRT_SOCKET_GID=$(stat -c '%g' /var/run/libvirt/libvirt-sock)
EOF
chmod 600 "$CONFIG_DIR/.env"; write_state configuration complete

stage 'Starting the Mars broker' broker_starting
if [[ "$MARS_ARTIFACT_MODE" == local ]]; then
  docker image inspect "$MARS_BROKER_IMAGE" >/dev/null
else
  docker manifest inspect "$MARS_BROKER_IMAGE" >/dev/null
fi
docker compose --env-file "$CONFIG_DIR/.env" -f "$COMPOSE_PATH" up -d
write_state complete complete
pass 'Linux broker installed; no job VM was started by installer'
