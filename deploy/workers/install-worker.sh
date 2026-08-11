#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"
command -v cosign >/dev/null || { echo 'cosign required' >&2; exit 1; }
command -v virsh >/dev/null || { echo 'libvirt required' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'linux-x64 only' >&2; exit 1; }
[[ -e /dev/kvm ]] || { echo '/dev/kvm required; refusing host-process fallback' >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { echo 'interactive controlling TTY required' >&2; exit 1; }
read -r -s -p 'Whitesmith one-use enrollment code: ' JOIN_CODE; printf '\n' >&2
cleanup(){ unset JOIN_CODE; [[ -n "${CIDATA:-}" && -e "$CIDATA" ]] && rm -f "$CIDATA"; }
trap cleanup EXIT
IMAGE="${WORKER_IMAGE:-whitesmith-worker-ubuntu-24.04.qcow2}"
BUNDLE="${WORKER_BUNDLE:-$IMAGE.sigstore.json}"
cosign verify-blob --bundle "$BUNDLE" --certificate-identity-regexp 'whitesmith-release' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' "$IMAGE" >/dev/null
CIDATA="$(mktemp -p "${TMPDIR:-/tmp}" whitesmith-cidata.XXXXXX)"; chmod 600 "$CIDATA"
python3 - "$CIDATA" "$PUBLIC_BASE_URL" "$JOIN_CODE" <<'PY'
import os,sys,zipfile
path,base,code=sys.argv[1:]
with zipfile.ZipFile(path,'w') as z:
 z.writestr('meta-data','instance-id: whitesmith-'+os.urandom(8).hex()+'\n')
 z.writestr('user-data','#cloud-config\nwrite_files: []\n')
 z.writestr('whitesmith-join',base+'\n'+code+'\n')
PY
VM_NAME="${WHITESMITH_VM_NAME:-whitesmith-worker}"
virsh define --validate "${WHITESMITH_DOMAIN_XML:?set WHITESMITH_DOMAIN_XML}" >/dev/null
virsh start "$VM_NAME" >/dev/null
echo "Worker started; adoption fingerprint will appear at $PUBLIC_BASE_URL"
