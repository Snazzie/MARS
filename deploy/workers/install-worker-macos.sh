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
CHECK=0
check() { CHECK=$((CHECK + 1)); print "[$CHECK/8] $1"; }
pass() { print "  [✓] $1"; }
print 'Whitesmith macOS worker enrollment'

check 'Checking macOS host and Tart'
[[ "$EUID" -ne 0 ]] || { echo 'Run this installer as the logged-in user, not with sudo.' >&2; exit 1; }
[[ "$(uname -m)" == arm64 ]] || { echo 'macos-arm64 required' >&2; exit 1; }
TART_BIN="$(command -v tart 2>/dev/null || true)"
[[ -n "$TART_BIN" ]] || { echo 'Tart required' >&2; exit 1; }
pass 'Apple Silicon and Tart detected'
configure_tart_sudo() {
  check 'Checking administrator permission for Tart'
  if sudo -n "$TART_BIN" --version >/dev/null 2>&1; then
    pass 'Tart administrator permission already configured'
    return 0
  fi
  echo 'Administrator permission is required once to enable Tart networking.' >&2
  sudo -v || { echo 'Administrator authorization was cancelled.' >&2; exit 1; }
  local sudoers="/etc/sudoers.d/whitesmith-tart-${USER}"
  printf '%s ALL=(root) NOPASSWD: %s\n' "$USER" "$TART_BIN" | sudo tee "$sudoers" >/dev/null || {
    echo 'Could not install the Tart administrator permission.' >&2
    exit 1
  }
  sudo chmod 440 "$sudoers"
  sudo visudo -cf "$sudoers" >/dev/null 2>&1 || {
    sudo rm -f "$sudoers"
    echo 'The Tart administrator permission failed validation.' >&2
    exit 1
  }
  sudo -n "$TART_BIN" --version >/dev/null 2>&1 || {
    echo 'Tart is not usable with the configured administrator permission.' >&2
    exit 1
  }
  pass 'Tart administrator permission configured'
}
configure_tart_sudo
check 'Validating control-plane URL'
: "${PUBLIC_BASE_URL:?installer origin missing}"
case "$PUBLIC_BASE_URL" in
  http://*|https://*) CURL_SECURITY=(--proto "=${PUBLIC_BASE_URL%%:*}") ;;
  *) echo 'Control-plane URL must use HTTP or HTTPS' >&2; exit 1 ;;
esac
pass 'Control-plane URL accepted'
check 'Checking the pinned Tart image'
: "${TART_IMAGE:?TART_IMAGE is required}"
: "${TART_IMAGE_DIGEST:?TART_IMAGE_DIGEST is required}"
IMAGE="$TART_IMAGE"
tart list | grep -q "$IMAGE" || { echo "Tart image '$IMAGE' is missing for user $USER" >&2; exit 1; }
pass "Tart image available: $IMAGE"

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
check 'Downloading the worker orchestrator'
curl --silent --show-error --fail "${CURL_SECURITY[@]}" --output "$TEMP_ORCHESTRATOR" "${PUBLIC_BASE_URL%/}/api/workers/orchestrator?audience=macos-arm64"
chmod 755 "$TEMP_ORCHESTRATOR"
mv -f "$TEMP_ORCHESTRATOR" "$ORCHESTRATOR"
pass 'Worker orchestrator downloaded'
check 'Storing the one-use enrollment code'
printf '%s\n' "$JOIN_CODE" > "$JOIN_CODE_FILE"
chmod 600 "$JOIN_CODE_FILE"
pass 'Enrollment code stored securely'
xml_escape() { local value="$1"; value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"; value="${value//\"/&quot;}"; value="${value//\'/&apos;}"; print -r -- "$value"; }
XML_LAUNCHER="$(xml_escape "$LAUNCHER")"
XML_STDOUT="$(xml_escape "$APP_DIR/worker.log")"
XML_STDERR="$(xml_escape "$APP_DIR/worker.error.log")"
check 'Installing the user-scoped worker service'
cat > "$LAUNCHER" <<EOF
#!/bin/zsh
set -euo pipefail
export PUBLIC_BASE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export WHITESMITH_CONTROL_PLANE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export WHITESMITH_ACTION_CACHE_ROOT=$(printf '%q' "${WHITESMITH_ACTION_CACHE_ROOT:-}")
export WHITESMITH_CACHE_PROXY_PORT=$(printf '%q' "${WHITESMITH_CACHE_PROXY_PORT:-}")
export WHITESMITH_CACHE_DATA_PORT=$(printf '%q' "${WHITESMITH_CACHE_DATA_PORT:-}")
export WHITESMITH_CACHE_PROXY_URL=$(printf '%q' "${WHITESMITH_CACHE_PROXY_URL:-}")
export WHITESMITH_CACHE_ADVERTISE_URL=$(printf '%q' "${WHITESMITH_CACHE_ADVERTISE_URL:-}")
export WHITESMITH_WORKER_IDENTITY_FILE=$(printf '%q' "$IDENTITY_FILE")
export WHITESMITH_JOIN_CODE_FILE=$(printf '%q' "$JOIN_CODE_FILE")
export WHITESMITH_TART_BASE_IMAGE=$(printf '%q' "$IMAGE")
export WHITESMITH_TART_IMAGE_DIGEST=$(printf '%q' "$TART_IMAGE_DIGEST")
export WHITESMITH_TART_EXECUTABLE=$(printf '%q' "$TART_BIN")
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
pass 'User-scoped worker service installed'
check 'Starting the worker'
launchctl bootout "gui/$UID/com.whitesmith.worker" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/com.whitesmith.worker"
pass 'Worker started; return to onboarding to verify its fingerprint'
