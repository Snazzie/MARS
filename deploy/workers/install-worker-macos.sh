#!/bin/zsh
set -euo pipefail

usage() { echo "usage: $0" >&2; exit 2; }
parse_args() {
  [ "$#" -eq 0 ] || usage
  JOIN_CODE=""
  [ -t 0 ] || { echo "interactive terminal required for enrollment code" >&2; exit 2; }
  read -r -s 'JOIN_CODE?Whitesmith enrollment code: '; printf '\n' >&2
  [[ "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
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
