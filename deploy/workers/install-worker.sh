#!/usr/bin/env bash
set -euo pipefail
umask 077
usage(){ echo "usage: $0 --code ENROLLMENT_CODE" >&2; exit 2; }
parse_args(){ [[ $# -eq 2 && $1 == --code ]] || usage; JOIN_CODE=$2; [[ $JOIN_CODE =~ ^[A-Za-z0-9_-]{43}$ ]] || usage; }
parse_args "$@"
# code=sys.stdin.readline() is intentionally never persisted; enrollment enters Docker over stdin.
trap 'unset JOIN_CODE' EXIT
: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"
validate_control_plane_url(){ python3 - "$PUBLIC_BASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit
raw = sys.argv[1]
try:
 parsed = urlsplit(raw); host = parsed.hostname; port = parsed.port
except ValueError:
 parsed = None; host = None; port = None
if not parsed or parsed.scheme not in {"https", "http"} or not host or parsed.username or parsed.password:
 raise SystemExit("PUBLIC_BASE_URL must use HTTP or HTTPS with a non-empty host and no credentials")
PY
}
validate_control_plane_url
: "${MARS_BROKER_IMAGE:?set digest-pinned broker image}"
: "${MARS_GOLDEN_IMAGE:?set HTTPS golden image URL}"
: "${MARS_GOLDEN_BUNDLE:?set HTTPS golden cosign bundle URL}"
: "${MARS_GOLDEN_DIGEST:?set golden sha256 digest}"
: "${MARS_COMPOSE_FILE:?set HTTPS compose URL}"
: "${MARS_COMPOSE_SHA256:?set compose SHA-256}"
: "${MARS_DOMAIN_TEMPLATE:?set HTTPS domain template URL}"
: "${MARS_DOMAIN_TEMPLATE_SHA256:?set domain template SHA-256}"
command -v docker >/dev/null || { echo 'Docker required' >&2; exit 1; }
docker compose version >/dev/null || { echo 'Docker Compose v2 required' >&2; exit 1; }
command -v virsh >/dev/null || { echo 'libvirt virsh required' >&2; exit 1; }
command -v qemu-img >/dev/null || { echo 'qemu-img required' >&2; exit 1; }
command -v cosign >/dev/null || { echo 'cosign required' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl required' >&2; exit 1; }
[[ "$MARS_BROKER_IMAGE" == *@sha256:* ]] || { echo 'broker image must be digest pinned' >&2; exit 1; }
docker manifest inspect "$MARS_BROKER_IMAGE" >/dev/null || { echo 'broker image unavailable' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'x86_64 required' >&2; exit 1; }
[[ -e /dev/kvm ]] || { echo '/dev/kvm required' >&2; exit 1; }
[[ -S /var/run/libvirt/libvirt-sock ]] || { echo 'libvirt socket required' >&2; exit 1; }
network_info="$(virsh net-info "${MARS_LIBVIRT_NETWORK:?set MARS_LIBVIRT_NETWORK}")"
case "$network_info" in *"Active:              yes"*) ;; *) echo 'configured libvirt network must be active' >&2; exit 1 ;; esac
validate_https_asset() {
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlsplit
raw, name = sys.argv[1:]
try:
 parsed = urlsplit(raw)
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
download_asset() {
  local url="$1" expected="$2" destination="$3" name="$4"
  validate_download_url "$url" "$name"
  validate_sha256 "$expected" "$name SHA-256"
  local parent tmp headers actual response_hash expected_hex
  local -a curl_security=(--silent --show-error --fail --location)
  [[ "$url" == https://* ]] && curl_security+=(--proto '=https' --tlsv1.2)
  parent="$(dirname "$destination")"; mkdir -p "$parent"
  tmp="${destination}.download.$$.$RANDOM"; headers="${tmp}.headers"
  DOWNLOAD_TMP="$tmp $headers"
  curl "${curl_security[@]}" --dump-header "$headers" --output "$tmp" "$url"
  expected_hex="${expected#sha256:}"
  actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
  [[ "$actual" == "$expected_hex" ]] || { echo "$name checksum mismatch: expected $expected_hex, got $actual" >&2; return 1; }
  response_hash="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="x-content-sha256:" {gsub("\r","",$2); print $2; exit}' "$headers")"
  [[ -z "$response_hash" || "$response_hash" == "$expected_hex" ]] || { echo "$name response hash mismatch" >&2; return 1; }
  mv -f "$tmp" "$destination"; rm -f "$headers"; DOWNLOAD_TMP=""
}
download_unverified() {
  local url="$1" destination="$2" name="$3"
  validate_https_asset "$url" "$name"
  local parent tmp
  parent="$(dirname "$destination")"; mkdir -p "$parent"
  tmp="${destination}.download.$$.$RANDOM"; DOWNLOAD_TMP="$tmp"
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --output "$tmp" "$url"
  mv -f "$tmp" "$destination"; DOWNLOAD_TMP=""
}
cleanup() {
  if [[ -n "${DOWNLOAD_TMP:-}" ]]; then
    for path in $DOWNLOAD_TMP; do rm -f "$path"; done
  fi
  unset JOIN_CODE
}
trap cleanup EXIT
CONFIG_DIR=${MARS_BROKER_CONFIG:-/var/lib/mars}
STATE_FILE=/var/lib/mars/install-state.json
LOG_FILE=/var/log/mars/install.log
mkdir -p "$CONFIG_DIR" /var/lib/mars /var/log/mars
exec > >(tee -a "$LOG_FILE") 2>&1
write_state() { printf '{"stage":"%s","status":"%s","updatedAt":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"; }
write_state preflight started
validate_https_asset "$MARS_GOLDEN_IMAGE" "golden image URL"
validate_https_asset "$MARS_GOLDEN_BUNDLE" "golden cosign bundle URL"
validate_sha256 "$MARS_GOLDEN_DIGEST" "golden image"
validate_sha256 "$MARS_COMPOSE_SHA256" "compose"
validate_sha256 "$MARS_DOMAIN_TEMPLATE_SHA256" "domain template"
GOLDEN_ROOT=${MARS_GOLDEN_ROOT:-$CONFIG_DIR/golden}
GOLDEN_PATH="$GOLDEN_ROOT/worker.qcow2"
BUNDLE_PATH="$CONFIG_DIR/worker.qcow2.bundle"
COMPOSE_PATH="$CONFIG_DIR/linux-broker-compose.yaml"
DOMAIN_PATH="$CONFIG_DIR/worker-domain.xml"
download_asset "$MARS_GOLDEN_IMAGE" "$MARS_GOLDEN_DIGEST" "$GOLDEN_PATH" "golden image"
download_unverified "$MARS_GOLDEN_BUNDLE" "$BUNDLE_PATH" "golden cosign bundle"
download_asset "$MARS_COMPOSE_FILE" "$MARS_COMPOSE_SHA256" "$COMPOSE_PATH" "compose"
download_asset "$MARS_DOMAIN_TEMPLATE" "$MARS_DOMAIN_TEMPLATE_SHA256" "$DOMAIN_PATH" "domain template"
cosign verify-blob --bundle "$BUNDLE_PATH" --certificate-identity-regexp 'mars-release' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' "$GOLDEN_PATH" >/dev/null
rm -f "$BUNDLE_PATH"
write_state assets_verified complete
mkdir -p "$GOLDEN_ROOT" "${MARS_CLONE_ROOT:-$CONFIG_DIR/clones}" "${MARS_CHANNEL_ROOT:-$CONFIG_DIR/channels}"
chmod 700 "$CONFIG_DIR"
chmod 0444 "$GOLDEN_PATH"
cat > "$CONFIG_DIR/.env" <<EOF
MARS_CONTROL_PLANE_URL=$PUBLIC_BASE_URL
MARS_BROKER_IMAGE=$MARS_BROKER_IMAGE
MARS_GOLDEN_DIGEST=$MARS_GOLDEN_DIGEST
MARS_BROKER_CONFIG=$CONFIG_DIR
MARS_GOLDEN_ROOT=$GOLDEN_ROOT
MARS_DOMAIN_TEMPLATE=$DOMAIN_PATH
MARS_CLONE_ROOT=${MARS_CLONE_ROOT:-$CONFIG_DIR/clones}
MARS_CHANNEL_ROOT=${MARS_CHANNEL_ROOT:-$CONFIG_DIR/channels}
LIBVIRT_SOCKET_GID=$(stat -c '%g' /var/run/libvirt/libvirt-sock)
EOF
write_state broker_starting started
printf '%s\n' "$JOIN_CODE" | docker compose --env-file "$CONFIG_DIR/.env" -f "$COMPOSE_PATH" up -d
write_state complete complete
unset JOIN_CODE
echo 'Linux broker installed; no job VM was started by installer.'
