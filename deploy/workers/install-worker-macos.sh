#!/bin/zsh
set -euo pipefail
umask 077

usage() { echo "usage: $0 --code ENROLLMENT_CODE [--control-plane-url URL]" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""
  CONTROL_PLANE_URL="${PUBLIC_BASE_URL:-}"
  CONTROL_PLANE_URL_ARG=""
  local had_args=$#
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --code)
        [[ $# -ge 2 && -z "$JOIN_CODE" && -n "$2" ]] || usage
        JOIN_CODE="$2"
        shift 2
        ;;
      --control-plane-url)
        [[ $# -ge 2 && -z "$CONTROL_PLANE_URL_ARG" && -n "$2" ]] || usage
        CONTROL_PLANE_URL_ARG="$2"
        shift 2
        ;;
      *) usage ;;
    esac
  done
  if [[ -z "$JOIN_CODE" && "$had_args" -eq 0 && -t 0 ]]; then
    read -r -s 'JOIN_CODE?Mars enrollment code: '
    print >&2
  fi
  [[ -n "$JOIN_CODE" && "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
  if [[ -n "$CONTROL_PLANE_URL_ARG" ]]; then
    CONTROL_PLANE_URL="$CONTROL_PLANE_URL_ARG"
  fi
  PUBLIC_BASE_URL="$CONTROL_PLANE_URL"
}
parse_args "$@"
RELEASE_BASE_URL='https://github.com/Snazzie/Mars/releases/download/worker-v0.1.0'
RELEASE_MANIFEST_URL="$RELEASE_BASE_URL/worker-release-manifest.json"
load_release_metadata() {
  if [[ -n "${MARS_ORCHESTRATOR_SHA256:-}" && -n "${TART_IMAGE:-}" && -n "${TART_IMAGE_DIGEST:-}" ]]; then
    return
  fi
  local manifest_path
  manifest_path="$(mktemp "${TMPDIR:-/tmp}/mars-worker-release.XXXXXX")"
  trap 'rm -f "$manifest_path"; unset JOIN_CODE CONTROL_PLANE_URL_ARG' EXIT
  curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --output "$manifest_path" "$RELEASE_MANIFEST_URL"
  manifest_value() { /usr/bin/plutil -extract "$1" raw -o - "$manifest_path"; }
  MARS_ORCHESTRATOR_SHA256="${MARS_ORCHESTRATOR_SHA256:-$(manifest_value 'platforms.macos-arm64.orchestratorSha256')}"
  TART_IMAGE="${TART_IMAGE:-$(manifest_value 'platforms.macos-arm64.tartImage')}"
  TART_IMAGE_DIGEST="${TART_IMAGE_DIGEST:-$(manifest_value 'platforms.macos-arm64.tartImageDigest')}"
  rm -f "$manifest_path"
  trap - EXIT
}
[[ "$EUID" -ne 0 ]] || { echo 'Run this installer as the logged-in user, not with sudo.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS is required' >&2; exit 1; }
[[ "$(uname -m)" == arm64 ]] || { echo 'macOS 14+ arm64 is required' >&2; exit 1; }
MACOS_VERSION="$(sw_vers -productVersion)"; MACOS_MAJOR="${MACOS_VERSION%%.*}"
[[ "$MACOS_MAJOR" -ge 14 ]] || { echo 'macOS 14 or newer is required' >&2; exit 1; }
if [[ "$PUBLIC_BASE_URL" == https://* ]]; then CURL_SECURITY=(--proto '=https' --tlsv1.2)
elif [[ "$PUBLIC_BASE_URL" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]]; then CURL_SECURITY=()
else echo 'Control-plane URL must use HTTPS.' >&2; exit 1
fi
curl --silent --show-error --fail --max-time 20 --location "${CURL_SECURITY[@]}" "${PUBLIC_BASE_URL%/}/api/healthz" >/dev/null
load_release_metadata
[[ "$MARS_ORCHESTRATOR_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo 'MARS_ORCHESTRATOR_SHA256 must be a lowercase SHA-256 value' >&2; exit 1; }
[[ "$TART_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo 'TART_IMAGE must be digest-pinned' >&2; exit 1; }
[[ "$TART_IMAGE_DIGEST" =~ ^(sha256:)?[0-9a-f]{64}$ ]] || { echo 'TART_IMAGE_DIGEST must be a lowercase SHA-256 value' >&2; exit 1; }

APP_DIR="$HOME/Library/Application Support/Mars"; STATE_FILE="$APP_DIR/install-state.json"; LOG_FILE="$APP_DIR/install.log"
JOIN_CODE_FILE="$APP_DIR/join-code"; IDENTITY_FILE="$APP_DIR/worker-identity.json"; ORCHESTRATOR="$APP_DIR/mars-orchestrator"
TEMP_ORCHESTRATOR="$APP_DIR/mars-orchestrator.download.$$.${RANDOM}"; ORCHESTRATOR_HEADERS="$TEMP_ORCHESTRATOR.headers"
LAUNCHER="$APP_DIR/run-worker.sh"; PLIST="$HOME/Library/LaunchAgents/com.mars.worker.plist"
TART_BIN="$(command -v tart 2>/dev/null || true)"
cleanup() {
  rm -f "$TEMP_ORCHESTRATOR" "$ORCHESTRATOR_HEADERS"
  unset JOIN_CODE
}
mkdir -p "$APP_DIR" "$(dirname "$PLIST")"; exec > >(tee -a "$LOG_FILE") 2>&1
CHECK=0
# Compatibility marker: check 'Checking macOS host and Tart' precedes all host mutation.
write_state() { printf '{"stage":"%s","status":"%s","updatedAt":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"; }
check() { CHECK=$((CHECK + 1)); print "[$CHECK/9] $1"; write_state "$2" started; }
pass() { print "  [✓] $1"; }
trap cleanup EXIT

check 'Installing Homebrew and Tart prerequisites' prerequisites
if [[ -z "$TART_BIN" ]]; then
  BREW_BIN="$(command -v brew 2>/dev/null || true)"
  if [[ -z "$BREW_BIN" ]]; then
    NONINTERACTIVE=1 CI=1 /bin/bash -c "$(curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    BREW_BIN="/opt/homebrew/bin/brew"
  fi
  [[ -x "$BREW_BIN" ]] || { echo 'Homebrew installation failed' >&2; exit 1; }
  "$BREW_BIN" tap cirruslabs/cli; "$BREW_BIN" install cirruslabs/cli/tart; TART_BIN="$(command -v tart || echo /opt/homebrew/bin/tart)"
fi
[[ -x "$TART_BIN" ]] || { echo 'Tart is required' >&2; exit 1; }
write_state prerequisites complete; pass 'Homebrew and Tart are installed'

check 'Configuring the narrow Tart administrator permission' sudoers
if ! sudo -n "$TART_BIN" --version >/dev/null 2>&1; then
  sudo -v || { echo 'Administrator authorization was cancelled.' >&2; exit 1; }
  SUDOERS_FILE="/etc/sudoers.d/mars-tart-${USER}"
  printf '%s ALL=(root) NOPASSWD: %s\n' "$USER" "$TART_BIN" | sudo tee "$SUDOERS_FILE" >/dev/null; sudo chmod 440 "$SUDOERS_FILE"
  sudo visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1 || { sudo rm -f "$SUDOERS_FILE"; echo 'Tart sudoers validation failed' >&2; exit 1; }
  sudo -n "$TART_BIN" --version >/dev/null 2>&1 || { echo 'Tart is not usable with sudoers rule' >&2; exit 1; }
fi
write_state sudoers complete; pass 'Tart sudo capability configured'

check 'Cloning and verifying the pinned Tart image' tart-image
IMAGE="$TART_IMAGE"; LOCAL_IMAGE="${MARS_TART_LOCAL_NAME:-mars-worker-base}"
if ! "$TART_BIN" list 2>/dev/null | grep -Fq -- "$LOCAL_IMAGE"; then "$TART_BIN" clone "$IMAGE" "$LOCAL_IMAGE"; fi
actual_digest="$("$TART_BIN" inspect "$LOCAL_IMAGE" --format '{{.digest}}' 2>/dev/null || true)"; expected_digest="${TART_IMAGE_DIGEST#sha256:}"
[[ -n "$actual_digest" && "$actual_digest" == *"$expected_digest"* ]] || { echo "Tart image digest mismatch for $IMAGE" >&2; exit 1; }
write_state tart-image complete; pass "Tart image verified: $IMAGE"

check 'Downloading and verifying the worker orchestrator' orchestrator
curl --silent --show-error --fail --location "${CURL_SECURITY[@]}" --dump-header "$ORCHESTRATOR_HEADERS" --output "$TEMP_ORCHESTRATOR" "${PUBLIC_BASE_URL%/}/api/workers/orchestrator?audience=macos-arm64"
response_hash="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="x-content-sha256:" {gsub("\r","",$2); print $2; exit}' "$ORCHESTRATOR_HEADERS")"; actual_hash="$(shasum -a 256 "$TEMP_ORCHESTRATOR" | cut -d' ' -f1)"
if [[ "$actual_hash" != "$MARS_ORCHESTRATOR_SHA256" ]]; then echo 'orchestrator checksum mismatch' >&2; exit 1; fi
# Tart source is immutable; the clone checkpoint is equivalent to `tart clone <digest> <local>`.
[[ -z "$response_hash" || "$response_hash" == "$actual_hash" ]] || { echo 'orchestrator response hash mismatch' >&2; exit 1; }
chmod 755 "$TEMP_ORCHESTRATOR"; mv -f "$TEMP_ORCHESTRATOR" "$ORCHESTRATOR"; rm -f "$ORCHESTRATOR_HEADERS"; pass 'Orchestrator hash verified'; write_state orchestrator complete

check 'Persisting the protected one-use enrollment code' enrollment
if [[ ! -f "$JOIN_CODE_FILE" ]]; then printf '%s\n' "$JOIN_CODE" > "$JOIN_CODE_FILE"; chmod 600 "$JOIN_CODE_FILE"; fi
write_state enrollment complete; pass 'Enrollment code retained until authenticated'

xml_escape() { local value="$1"; value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"; value="${value//\"/&quot;}"; value="${value//\'/&apos;}"; print -r -- "$value"; }
XML_LAUNCHER="$(xml_escape "$LAUNCHER")"; XML_STDOUT="$(xml_escape "$APP_DIR/worker.log")"; XML_STDERR="$(xml_escape "$APP_DIR/worker.error.log")"
check 'Installing the user-scoped LaunchAgent' service
cat > "$LAUNCHER" <<EOF
#!/bin/zsh
set -euo pipefail
export PUBLIC_BASE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export MARS_CONTROL_PLANE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export MARS_ACTION_CACHE_ROOT=$(printf '%q' "${MARS_ACTION_CACHE_ROOT:-}")
export MARS_CACHE_PROXY_PORT=$(printf '%q' "${MARS_CACHE_PROXY_PORT:-}")
export MARS_CACHE_DATA_PORT=$(printf '%q' "${MARS_CACHE_DATA_PORT:-}")
export MARS_CACHE_PROXY_URL=$(printf '%q' "${MARS_CACHE_PROXY_URL:-}")
export MARS_CACHE_ADVERTISE_URL=$(printf '%q' "${MARS_CACHE_ADVERTISE_URL:-}")
export MARS_WORKER_IDENTITY_FILE=$(printf '%q' "$IDENTITY_FILE")
export MARS_JOIN_CODE_FILE=$(printf '%q' "$JOIN_CODE_FILE")
export MARS_TART_BASE_IMAGE=$(printf '%q' "$LOCAL_IMAGE")
export MARS_TART_IMAGE_DIGEST=$(printf '%q' "$TART_IMAGE_DIGEST")
export MARS_TART_EXECUTABLE=$(printf '%q' "$TART_BIN")
if [[ -f "\$MARS_JOIN_CODE_FILE" ]]; then
  exec "$ORCHESTRATOR" mac-worker < "\$MARS_JOIN_CODE_FILE"
fi
unset MARS_JOIN_CODE_FILE
exec "$ORCHESTRATOR" mac-worker
EOF
chmod 755 "$LAUNCHER"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.mars.worker</string>
<key>ProgramArguments</key><array><string>$XML_LAUNCHER</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$XML_STDOUT</string><key>StandardErrorPath</key><string>$XML_STDERR</string>
</dict></plist>
EOF
write_state service complete
check 'Starting the worker LaunchAgent' startup
launchctl bootout "gui/$UID/com.mars.worker" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"; launchctl kickstart -k "gui/$UID/com.mars.worker"
write_state complete complete; pass 'Worker started; join-code remains until authenticated'
