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
: "${WHITESMITH_BROKER_IMAGE:?set digest-pinned broker image}"
: "${WHITESMITH_GOLDEN_IMAGE:?set signed golden qcow2}"
: "${WHITESMITH_GOLDEN_BUNDLE:?set golden cosign bundle}"
: "${WHITESMITH_GOLDEN_DIGEST:?set golden sha256 digest}"
command -v docker >/dev/null || { echo 'Docker required' >&2; exit 1; }
docker compose version >/dev/null || { echo 'Docker Compose v2 required' >&2; exit 1; }
command -v virsh >/dev/null || { echo 'libvirt virsh required' >&2; exit 1; }
command -v qemu-img >/dev/null || { echo 'qemu-img required' >&2; exit 1; }
command -v cosign >/dev/null || { echo 'cosign required' >&2; exit 1; }
[[ "$WHITESMITH_BROKER_IMAGE" == *@sha256:* ]] || { echo 'broker image must be digest pinned' >&2; exit 1; }
docker manifest inspect "$WHITESMITH_BROKER_IMAGE" >/dev/null || { echo 'broker image unavailable' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'x86_64 required' >&2; exit 1; }
[[ -e /dev/kvm ]] || { echo '/dev/kvm required' >&2; exit 1; }
[[ -S /var/run/libvirt/libvirt-sock ]] || { echo 'libvirt socket required' >&2; exit 1; }
network_info="$(virsh net-info "${WHITESMITH_LIBVIRT_NETWORK:?set WHITESMITH_LIBVIRT_NETWORK}")"
case "$network_info" in *"Active:              yes"*) ;; *) echo 'configured libvirt network must be active' >&2; exit 1 ;; esac
actual_digest="sha256:$(sha256sum "$WHITESMITH_GOLDEN_IMAGE" | cut -d' ' -f1)"
[[ "$actual_digest" == "$WHITESMITH_GOLDEN_DIGEST" ]] || { echo 'golden digest mismatch' >&2; exit 1; }
CONFIG_DIR=${WHITESMITH_BROKER_CONFIG:-/mnt/user/appdata/whitesmith-broker}
GOLDEN_ROOT=${WHITESMITH_GOLDEN_ROOT:-$CONFIG_DIR/golden}
cosign verify-blob --bundle "$WHITESMITH_GOLDEN_BUNDLE" --certificate-identity-regexp 'whitesmith-release' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' "$WHITESMITH_GOLDEN_IMAGE" >/dev/null
mkdir -p "$CONFIG_DIR" "$GOLDEN_ROOT" "${WHITESMITH_CLONE_ROOT:-$CONFIG_DIR/clones}" "${WHITESMITH_CHANNEL_ROOT:-$CONFIG_DIR/channels}"
chmod 700 "$CONFIG_DIR"
install -m 0444 "$WHITESMITH_GOLDEN_IMAGE" "$GOLDEN_ROOT/worker.qcow2"
cat > "$CONFIG_DIR/.env" <<EOF
WHITESMITH_CONTROL_PLANE_URL=$PUBLIC_BASE_URL
WHITESMITH_BROKER_IMAGE=$WHITESMITH_BROKER_IMAGE
WHITESMITH_GOLDEN_DIGEST=$WHITESMITH_GOLDEN_DIGEST
WHITESMITH_BROKER_CONFIG=$CONFIG_DIR
WHITESMITH_GOLDEN_ROOT=$GOLDEN_ROOT
WHITESMITH_CLONE_ROOT=${WHITESMITH_CLONE_ROOT:-$CONFIG_DIR/clones}
WHITESMITH_CHANNEL_ROOT=${WHITESMITH_CHANNEL_ROOT:-$CONFIG_DIR/channels}
LIBVIRT_SOCKET_GID=$(stat -c '%g' /var/run/libvirt/libvirt-sock)
EOF
printf '%s\n' "$JOIN_CODE" | docker compose --env-file "$CONFIG_DIR/.env" -f "${WHITESMITH_COMPOSE_FILE:?set WHITESMITH_COMPOSE_FILE}" up -d
unset JOIN_CODE
echo 'Linux broker installed; no job VM was started by installer.'
