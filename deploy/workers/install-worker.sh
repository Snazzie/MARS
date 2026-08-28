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

: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"
: "${MARS_BROKER_IMAGE:?set digest-pinned broker image}"
: "${MARS_GOLDEN_IMAGE:?set HTTPS golden image URL}"
: "${MARS_GOLDEN_BUNDLE:?set HTTPS golden cosign bundle URL}"
: "${MARS_GOLDEN_DIGEST:?set golden sha256 digest}"
: "${MARS_COMPOSE_FILE:?set HTTPS compose URL}"
: "${MARS_COMPOSE_SHA256:?set compose SHA-256}"
: "${MARS_DOMAIN_TEMPLATE:?set HTTPS domain template URL}"
: "${MARS_DOMAIN_TEMPLATE_SHA256:?set domain template SHA-256}"

validate_control_plane_url() {
  python3 - "$PUBLIC_BASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit
raw = sys.argv[1]
try:
    parsed = urlsplit(raw)
    host = parsed.hostname
    parsed.port
except ValueError:
    parsed = None
    host = None
if not parsed or parsed.scheme not in {"https", "http"} or not host or parsed.username or parsed.password or parsed.query or parsed.fragment:
    raise SystemExit("PUBLIC_BASE_URL must use HTTP or HTTPS with a non-empty host and no credentials")
PY
}
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
validate_download_url() {
  local url="$1" name="$2"
  if [[ "$url" == https://* ]]; then validate_https_asset "$url" "$name"; return; fi
  [[ "$url" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] || { echo "$name must use HTTPS" >&2; exit 1; }
}
validate_sha256() { [[ "$1" =~ ^(sha256:)?[0-9a-f]{64}$ ]] || { echo "$2 must be a lowercase SHA-256 value" >&2; exit 1; }; }

preflight() {
  validate_control_plane_url
  validate_https_asset "$MARS_GOLDEN_IMAGE" "golden image URL"
  validate_https_asset "$MARS_GOLDEN_BUNDLE" "golden cosign bundle URL"
  validate_sha256 "$MARS_GOLDEN_DIGEST" "golden image"
  validate_sha256 "$MARS_COMPOSE_SHA256" "compose"
  validate_sha256 "$MARS_DOMAIN_TEMPLATE_SHA256" "domain template"
  [[ "$(uname -s)" == Linux ]] || { echo 'Linux is required' >&2; exit 1; }
  [[ "$(uname -m)" == x86_64 ]] || { echo 'Ubuntu 24.04 x64 is required' >&2; exit 1; }
  [[ -r /etc/os-release ]] || { echo '/etc/os-release is required' >&2; exit 1; }
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo 'Ubuntu 24.04 is required' >&2; exit 1; }
  [[ "$MARS_BROKER_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo 'broker image must be digest pinned' >&2; exit 1; }
  command -v apt-get >/dev/null || { echo 'apt-get required' >&2; exit 1; }
  command -v curl >/dev/null || { echo 'curl required' >&2; exit 1; }
  local local_http=false
  [[ "$PUBLIC_BASE_URL" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] && local_http=true
  if [[ "$local_http" == true ]]; then
    curl --silent --show-error --fail --max-time 15 --location "$PUBLIC_BASE_URL/api/healthz" >/dev/null
  else
    curl --silent --show-error --fail --max-time 15 --location --proto '=https' --tlsv1.2 "$PUBLIC_BASE_URL/api/healthz" >/dev/null
  fi
}

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  command -v sudo >/dev/null || { echo 'Root or sudo is required.' >&2; exit 1; }
  exec sudo --preserve-env=PUBLIC_BASE_URL,MARS_BROKER_IMAGE,MARS_GOLDEN_IMAGE,MARS_GOLDEN_BUNDLE,MARS_GOLDEN_DIGEST,MARS_COMPOSE_FILE,MARS_COMPOSE_SHA256,MARS_DOMAIN_TEMPLATE,MARS_DOMAIN_TEMPLATE_SHA256,MARS_BROKER_CONFIG,MARS_LIBVIRT_NETWORK,MARS_COSIGN_VERSION,MARS_COSIGN_SHA256,MARS_ACTION_CACHE_ROOT,MARS_CACHE_PROXY_PORT,MARS_CACHE_DATA_PORT,MARS_CACHE_PROXY_URL,MARS_CACHE_ADVERTISE_URL "$0" "$@"
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
if ! command -v cosign >/dev/null; then
  COSIGN_VERSION=${MARS_COSIGN_VERSION:-v2.4.1}
  COSIGN_URL="https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"
  COSIGN_TMP="/tmp/cosign.$$"
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --output "$COSIGN_TMP" "$COSIGN_URL"
  if [[ -n "${MARS_COSIGN_SHA256:-}" ]]; then
    validate_sha256 "$MARS_COSIGN_SHA256" "cosign"
    [[ "$(sha256sum "$COSIGN_TMP" | cut -d' ' -f1)" == "${MARS_COSIGN_SHA256#sha256:}" ]] || { rm -f "$COSIGN_TMP"; echo 'cosign checksum mismatch' >&2; exit 1; }
  fi
  chmod 0755 "$COSIGN_TMP"; install -m 0755 "$COSIGN_TMP" /usr/local/bin/cosign; rm -f "$COSIGN_TMP"
fi
command -v cosign >/dev/null || { echo 'pinned cosign binary is required' >&2; exit 1; }
pass 'Docker Engine, Compose v2, libvirt, QEMU, curl, and cosign installed'
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

validate_download_url() { local url="$1" name="$2"; if [[ "$url" == https://* ]]; then validate_https_asset "$url" "$name"; return; fi; [[ "$url" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] || { echo "$name must use HTTPS" >&2; exit 1; }; }
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
download_unverified() {
  local url="$1" destination="$2" name="$3"; validate_https_asset "$url" "$name"; local tmp="${destination}.download.$$.$RANDOM"; DOWNLOAD_TMP="$tmp"; mkdir -p "$(dirname "$destination")"; curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --output "$tmp" "$url"; mv -f "$tmp" "$destination"; DOWNLOAD_TMP=""
}

stage 'Downloading and verifying immutable worker assets' download_verified
GOLDEN_ROOT=${MARS_GOLDEN_ROOT:-$CONFIG_DIR/golden}; GOLDEN_PATH="$GOLDEN_ROOT/worker.qcow2"; BUNDLE_PATH="$CONFIG_DIR/worker.qcow2.bundle"; COMPOSE_PATH="$CONFIG_DIR/linux-broker-compose.yaml"; DOMAIN_PATH="$CONFIG_DIR/worker-domain.xml"
download_asset "$MARS_GOLDEN_IMAGE" "$MARS_GOLDEN_DIGEST" "$GOLDEN_PATH" 'golden image'
download_unverified "$MARS_GOLDEN_BUNDLE" "$BUNDLE_PATH" 'golden cosign bundle'
download_asset "$MARS_COMPOSE_FILE" "$MARS_COMPOSE_SHA256" "$COMPOSE_PATH" compose
download_asset "$MARS_DOMAIN_TEMPLATE" "$MARS_DOMAIN_TEMPLATE_SHA256" "$DOMAIN_PATH" 'domain template'
cosign verify-blob --bundle "$BUNDLE_PATH" --certificate-identity-regexp 'https://github\.com/[^/]+/[^/]+/\.github/workflows/release-workers\.yml@.*' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' "$GOLDEN_PATH" >/dev/null
rm -f "$BUNDLE_PATH"; chmod 0444 "$GOLDEN_PATH"; pass 'Hashes, release signature, and broker metadata verified'; write_state download_verified complete

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
docker manifest inspect "$MARS_BROKER_IMAGE" >/dev/null
docker compose --env-file "$CONFIG_DIR/.env" -f "$COMPOSE_PATH" up -d
write_state complete complete
pass 'Linux broker installed; no job VM was started by installer'
