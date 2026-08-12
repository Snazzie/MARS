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
  http://*|https://*) CURL_SECURITY=(--proto "=${PUBLIC_BASE_URL%%:*}") ;;
  *) echo 'Control-plane URL must use HTTP or HTTPS' >&2; exit 1 ;;
esac

APP_DIR="$HOME/Library/Application Support/Whitesmith"
ORCHESTRATOR="$APP_DIR/whitesmith-orchestrator"
TEMP_ORCHESTRATOR="$ORCHESTRATOR.tmp.$$"
IDENTITY_FILE="$APP_DIR/worker-identity.json"
JOIN_CODE_FILE="$APP_DIR/join-code"
LAUNCHER="$APP_DIR/run-worker.sh"
PLIST="$HOME/Library/LaunchAgents/com.whitesmith.worker.plist"
mkdir -p "$APP_DIR" "$(dirname "$PLIST")"
cleanup() { unset JOIN_CODE; rm -f "$TEMP_ORCHESTRATOR"; }
trap cleanup EXIT
curl --silent --show-error --fail "${CURL_SECURITY[@]}" --output "$TEMP_ORCHESTRATOR" "${PUBLIC_BASE_URL%/}/api/workers/orchestrator?audience=macos-arm64"
chmod 755 "$TEMP_ORCHESTRATOR"
mv -f "$TEMP_ORCHESTRATOR" "$ORCHESTRATOR"
printf '%s\n' "$JOIN_CODE" > "$JOIN_CODE_FILE"
chmod 600 "$JOIN_CODE_FILE"
xml_escape() { local value="$1"; value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"; value="${value//\"/&quot;}"; value="${value//\'/&apos;}"; print -r -- "$value"; }
XML_LAUNCHER="$(xml_escape "$LAUNCHER")"
XML_STDOUT="$(xml_escape "$APP_DIR/worker.log")"
XML_STDERR="$(xml_escape "$APP_DIR/worker.error.log")"
cat > "$LAUNCHER" <<EOF
#!/bin/zsh
set -euo pipefail
export PUBLIC_BASE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export WHITESMITH_CONTROL_PLANE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export WHITESMITH_WORKER_IDENTITY_FILE=$(printf '%q' "$IDENTITY_FILE")
export WHITESMITH_JOIN_CODE_FILE=$(printf '%q' "$JOIN_CODE_FILE")
if [[ -f "\$WHITESMITH_WORKER_IDENTITY_FILE" ]]; then
  rm -f "\$WHITESMITH_JOIN_CODE_FILE"
  exec "$ORCHESTRATOR" mac-worker
fi
exec "$ORCHESTRATOR" mac-worker < "\$WHITESMITH_JOIN_CODE_FILE"
EOF
chmod 755 "$LAUNCHER"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.whitesmith.worker</string>
<key>ProgramArguments</key><array><string>$XML_LAUNCHER</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$XML_STDOUT</string>
<key>StandardErrorPath</key><string>$XML_STDERR</string>
</dict></plist>
EOF
launchctl bootout "gui/$UID/com.whitesmith.worker" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/com.whitesmith.worker"
printf '%s\n' 'Worker enrollment service installed and started. Return to onboarding to verify its fingerprint.'
