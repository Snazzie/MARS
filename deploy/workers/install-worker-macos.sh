#!/bin/zsh
set -euo pipefail
[[ "$(uname -m)" == arm64 ]] || { echo 'macos-arm64 required' >&2; exit 1; }
[[ -t 0 && -t 1 ]] || { echo 'interactive controlling TTY required' >&2; exit 1; }
read -r -s 'JOIN_CODE?Whitesmith one-use enrollment code: '; print
trap 'unset JOIN_CODE' EXIT
command -v tart >/dev/null || { echo 'Tart required' >&2; exit 1; }
command -v codesign >/dev/null || { echo 'codesign required' >&2; exit 1; }
IMAGE="${TART_IMAGE:-whitesmith-macos-worker}"
tart list | grep -q "$IMAGE" || { echo 'signed Tart image missing' >&2; exit 1; }
launchctl bootstrap system /Library/LaunchDaemons/com.whitesmith.worker.plist
printf '%s\n' "$JOIN_CODE" | /usr/local/bin/whitesmith-orchestrator join --platform macos-arm64 --code-stdin
