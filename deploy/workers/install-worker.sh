#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() { echo "usage: $0 --code <43-character-base64url>" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""
  CODE_SEEN=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --code) [ "$CODE_SEEN" -eq 0 ] && [ "$#" -ge 2 ] || usage; CODE_SEEN=1; JOIN_CODE=$2; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
}
parse_args "$@"
trap 'unset JOIN_CODE' EXIT

umask 077
: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"
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
