#!/bin/zsh
set -euo pipefail
umask 077

usage() { echo "usage: $0" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""
  if [ "$#" -eq 2 ] && [ "$1" = "--code" ]; then
    JOIN_CODE="$2"
  elif [ "$#" -eq 0 ] && [ -t 0 ]; then
    read -r -s 'JOIN_CODE?Whitesmith enrollment code: '; printf '\n' >&2
  else
    usage
  fi
  [[ "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
}
parse_args "$@"
trap 'unset JOIN_CODE' EXIT

[[ "$(uname -m)" == arm64 ]] || { echo 'macos-arm64 required' >&2; exit 1; }
command -v tart >/dev/null || { echo 'Tart required' >&2; exit 1; }
: "${PUBLIC_BASE_URL:?installer origin missing}"
IMAGE="${TART_IMAGE:-whitesmith-macos-worker}"
tart list | grep -q "$IMAGE" || { echo "Tart image '$IMAGE' is missing for user $USER" >&2; exit 1; }

case "$PUBLIC_BASE_URL" in
  http://localhost:*|http://127.0.0.1:*) CURL_SECURITY=(--proto '=http') ;;
  https://*) CURL_SECURITY=(--proto '=https' --tlsv1.3) ;;
  *) echo 'Control-plane URL must use HTTPS unless it targets loopback' >&2; exit 1 ;;
esac

APP_DIR="$HOME/Library/Application Support/Whitesmith"
ORCHESTRATOR="$APP_DIR/whitesmith-orchestrator"
TEMP_ORCHESTRATOR="$ORCHESTRATOR.tmp.$$"
mkdir -p "$APP_DIR"
cleanup() { unset JOIN_CODE; rm -f "$TEMP_ORCHESTRATOR"; }
trap cleanup EXIT
curl --silent --show-error --fail "${CURL_SECURITY[@]}" --output "$TEMP_ORCHESTRATOR" "${PUBLIC_BASE_URL%/}/api/workers/orchestrator?audience=macos-arm64"
chmod 755 "$TEMP_ORCHESTRATOR"
mv -f "$TEMP_ORCHESTRATOR" "$ORCHESTRATOR"
printf '%s\n' "$JOIN_CODE" | WHITESMITH_CONTROL_PLANE_URL="$PUBLIC_BASE_URL" "$ORCHESTRATOR" join macos-arm64
printf '%s\n' 'Worker enrollment requested. Return to onboarding to verify its fingerprint.'
