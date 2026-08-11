#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() { echo "usage: $0" >&2; exit 2; }
parse_args() {
  [ "$#" -eq 0 ] || usage
  JOIN_CODE=""
  [ -t 0 ] || { echo "interactive terminal required for enrollment code" >&2; exit 2; }
  read -r -s -p "Whitesmith enrollment code: " JOIN_CODE; printf '\n' >&2
  [[ "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
}
validate_control_plane_url() {
  python3 - "$PUBLIC_BASE_URL" <<'PY'
import sys
from urllib.parse import urlsplit
raw = sys.argv[1]
try:
    parsed = urlsplit(raw)
    host = parsed.hostname
    port = parsed.port
except ValueError:
    parsed = None
    host = None
    port = None
loopback = host in {"localhost", "127.0.0.1", "::1"}
if not parsed or parsed.scheme not in {"https", "http"} or not host or parsed.username or parsed.password or (parsed.scheme == "http" and not loopback):
    raise SystemExit("PUBLIC_BASE_URL must use HTTPS with a non-empty host and no credentials")
PY
}
parse_args "$@"
trap 'unset JOIN_CODE' EXIT

umask 077
: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"
validate_control_plane_url
command -v cosign >/dev/null || { echo 'cosign required' >&2; exit 1; }
command -v virsh >/dev/null || { echo 'libvirt required' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'linux-x64 only' >&2; exit 1; }
[[ -e /dev/kvm ]] || { echo '/dev/kvm required; refusing host-process fallback' >&2; exit 1; }
cleanup(){ unset JOIN_CODE; [[ -n "${CIDATA:-}" && -e "$CIDATA" ]] && rm -f "$CIDATA"; }
trap cleanup EXIT
IMAGE="${WORKER_IMAGE:-whitesmith-worker-ubuntu-24.04.qcow2}"
BUNDLE="${WORKER_BUNDLE:-$IMAGE.sigstore.json}"
cosign verify-blob --bundle "$BUNDLE" --certificate-identity-regexp 'whitesmith-release' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' "$IMAGE" >/dev/null
CIDATA="$(mktemp -p "${TMPDIR:-/tmp}" whitesmith-cidata.XXXXXX)"; chmod 600 "$CIDATA"
printf '%s\n' "$JOIN_CODE" | python3 -c '
import os,sys,zipfile
path,base=sys.argv[1:]
code=sys.stdin.readline().rstrip("\n")
with zipfile.ZipFile(path,"w") as z:
 z.writestr("meta-data","instance-id: whitesmith-"+os.urandom(8).hex()+"\n")
 z.writestr("user-data","#cloud-config\nwrite_files: []\n")
 z.writestr("whitesmith-join",base+"\n"+code+"\n")
' "$CIDATA" "$PUBLIC_BASE_URL"
VM_NAME="${WHITESMITH_VM_NAME:-whitesmith-worker}"
virsh define --validate "${WHITESMITH_DOMAIN_XML:?set WHITESMITH_DOMAIN_XML}" >/dev/null
virsh start "$VM_NAME" >/dev/null
echo "Worker started; adoption fingerprint will appear at $PUBLIC_BASE_URL"
