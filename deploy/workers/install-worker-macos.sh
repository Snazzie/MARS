#!/bin/zsh
set -euo pipefail

usage() { echo "usage: $0 --code <43-character-base64url>" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --code) [ -z "$JOIN_CODE" ] && [ "$#" -ge 2 ] || usage; JOIN_CODE=$2; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "$JOIN_CODE" =~ '^[A-Za-z0-9_-]{43}$' ]] || usage
}
parse_args "$@"
trap 'unset JOIN_CODE' EXIT
[[ "$(uname -m)" == arm64 ]] || { echo 'macos-arm64 required' >&2; exit 1; }
command -v tart >/dev/null || { echo 'Tart required' >&2; exit 1; }
command -v codesign >/dev/null || { echo 'codesign required' >&2; exit 1; }
IMAGE="${TART_IMAGE:-whitesmith-macos-worker}"
tart list | grep -q "$IMAGE" || { echo 'signed Tart image missing' >&2; exit 1; }
launchctl bootstrap system /Library/LaunchDaemons/com.whitesmith.worker.plist
printf '%s\n' "$JOIN_CODE" | /usr/local/bin/whitesmith-orchestrator join --platform macos-arm64 --code-stdin
