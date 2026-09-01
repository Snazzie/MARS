#!/bin/zsh
set -euo pipefail
umask 077

usage() { echo "usage: $0 --code ENROLLMENT_CODE [--control-plane-url URL]" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""; CONTROL_PLANE_URL="${PUBLIC_BASE_URL:-}"; CONTROL_PLANE_URL_ARG=""; local had_args=$#
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --code) [[ $# -ge 2 && -z "$JOIN_CODE" && -n "$2" ]] || usage; JOIN_CODE="$2"; shift 2 ;;
      --control-plane-url) [[ $# -ge 2 && -z "$CONTROL_PLANE_URL_ARG" && -n "$2" ]] || usage; CONTROL_PLANE_URL_ARG="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  if [[ -z "$JOIN_CODE" && "$had_args" -eq 0 && -t 0 ]]; then read -r -s 'JOIN_CODE?Mars enrollment code: '; print >&2; fi
  [[ -n "$JOIN_CODE" && "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage
  [[ -z "$CONTROL_PLANE_URL_ARG" ]] || CONTROL_PLANE_URL="$CONTROL_PLANE_URL_ARG"
  PUBLIC_BASE_URL="$CONTROL_PLANE_URL"
}
parse_args "$@"
require_config() {
  [[ -n "${PUBLIC_BASE_URL:-}" ]] || { echo 'PUBLIC_BASE_URL is required' >&2; exit 1; }
  [[ -n "${MARS_ARTIFACT_MODE:-}" ]] || { echo 'MARS_ARTIFACT_MODE is required' >&2; exit 1; }
  [[ -n "${MARS_ORCHESTRATOR_URL:-}" ]] || { echo 'MARS_ORCHESTRATOR_URL is required' >&2; exit 1; }
  [[ -n "${MARS_ORCHESTRATOR_SHA256:-}" ]] || { echo 'MARS_ORCHESTRATOR_SHA256 is required' >&2; exit 1; }
  [[ -n "${MARS_JOB_AGENT_URL:-}" ]] || { echo 'MARS_JOB_AGENT_URL is required' >&2; exit 1; }
  [[ -n "${MARS_JOB_AGENT_SHA256:-}" ]] || { echo 'MARS_JOB_AGENT_SHA256 is required' >&2; exit 1; }
  [[ -n "${IMAGE_PREPARATION_SCRIPT_URL:-}" ]] || { echo 'IMAGE_PREPARATION_SCRIPT_URL is required' >&2; exit 1; }
  [[ -n "${IMAGE_PREPARATION_SCRIPT_SHA256:-}" ]] || { echo 'IMAGE_PREPARATION_SCRIPT_SHA256 is required' >&2; exit 1; }
  [[ -n "${TART_IMAGE:-}" ]] || { echo 'TART_IMAGE is required' >&2; exit 1; }
}
validate_http_url() {
  local raw="$1" name="$2" kind="$3" scheme rest authority suffix host port
  local authority_pattern='^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._~-]+)(:([0-9]+))?$'
  if [[ "$raw" == https://* ]]; then scheme=https; rest="${raw#https://}"; elif [[ "$raw" == http://* ]]; then scheme=http; rest="${raw#http://}"; else echo "$name must use HTTP(S) without credentials or fragments" >&2; return 1; fi
  authority="${rest%%[/?]*}"; suffix="${rest#$authority}"
  if [[ -z "$authority" || "$authority" == *"@"* || "$raw" == *"#"* ]] || ! [[ "$authority" =~ $authority_pattern ]]; then echo "$name must use HTTP(S) without credentials or fragments" >&2; return 1; fi
  host="$match[1]"; port="$match[3]"; if [[ "$kind" == origin && -n "$suffix" && "$suffix" != "/" ]]; then echo "$name must be an HTTP(S) origin without a path, query, credentials, or fragment" >&2; return 1; fi
  [[ -n "$port" ]] || { [[ "$scheme" == https ]] && port=443 || port=80; }
  URL_SCHEME="$scheme"; URL_ORIGIN="${scheme}://$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]'):${port}"
}
validate_oci_digest() { [[ "$1" =~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$' ]] || { echo "$2 must be a lowercase digest-pinned OCI reference" >&2; exit 1; }; }
validate_config() {
  require_config; [[ "$MARS_ARTIFACT_MODE" == local || "$MARS_ARTIFACT_MODE" == production ]] || { echo 'MARS_ARTIFACT_MODE must be local or production' >&2; exit 1; }
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"; validate_http_url "$PUBLIC_BASE_URL" PUBLIC_BASE_URL origin || exit 1; local public_origin="$URL_ORIGIN" public_scheme="$URL_SCHEME"
  if [[ "$MARS_ARTIFACT_MODE" == production && "$public_scheme" != https ]]; then echo 'PUBLIC_BASE_URL must use HTTPS in production' >&2; exit 1; fi
  if [[ "$public_scheme" == https ]]; then CURL_SECURITY=(--proto '=https' --tlsv1.2); else CURL_SECURITY=(); fi
  for pair in "MARS_ORCHESTRATOR_URL:$MARS_ORCHESTRATOR_URL" "MARS_JOB_AGENT_URL:$MARS_JOB_AGENT_URL" "IMAGE_PREPARATION_SCRIPT_URL:$IMAGE_PREPARATION_SCRIPT_URL"; do local name="${pair%%:*}" url="${pair#*:}"; validate_http_url "$url" "$name" asset || exit 1; if [[ "$MARS_ARTIFACT_MODE" == production && "$URL_SCHEME" != https ]]; then echo "$name must use HTTPS in production" >&2; exit 1; fi; if [[ "$MARS_ARTIFACT_MODE" == local && "$URL_ORIGIN" != "$public_origin" ]]; then echo "$name must use the same origin as PUBLIC_BASE_URL in local mode" >&2; exit 1; fi; done
  for pair in "MARS_ORCHESTRATOR_SHA256:$MARS_ORCHESTRATOR_SHA256" "MARS_JOB_AGENT_SHA256:$MARS_JOB_AGENT_SHA256" "IMAGE_PREPARATION_SCRIPT_SHA256:$IMAGE_PREPARATION_SCRIPT_SHA256"; do local name="${pair%%:*}" hash="${pair#*:}"; [[ "$hash" =~ '^[0-9a-f]{64}$' ]] || { echo "$name must be a lowercase SHA-256 value" >&2; exit 1; }; done
  validate_oci_digest "$TART_IMAGE" TART_IMAGE; TART_IMAGE_DIGEST="${TART_IMAGE##*@}"
}
validate_config
trap 'unset JOIN_CODE CONTROL_PLANE_URL_ARG' EXIT
[[ "$EUID" -ne 0 ]] || { echo 'Run this installer as the logged-in user, not with sudo.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS is required' >&2; exit 1; }
[[ "$(uname -m)" == arm64 ]] || { echo 'macOS 14+ arm64 is required' >&2; exit 1; }
MACOS_VERSION="$(sw_vers -productVersion)"; MACOS_MAJOR="${MACOS_VERSION%%.*}"; [[ "$MACOS_MAJOR" -ge 14 ]] || { echo 'macOS 14 or newer is required' >&2; exit 1; }
curl --silent --show-error --fail --max-time 20 --location "${CURL_SECURITY[@]}" "${PUBLIC_BASE_URL%/}/api/healthz" >/dev/null

DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mars-worker.XXXXXX")"
APP_DIR="$HOME/Library/Application Support/Mars"; STATE_FILE="$APP_DIR/install-state.json"; LOG_FILE="$APP_DIR/install.log"
ORCHESTRATOR_STAGE="$DOWNLOAD_DIR/mars-orchestrator"; JOB_AGENT_STAGE="$DOWNLOAD_DIR/mars-job-agent"; PREPARER_STAGE="$DOWNLOAD_DIR/prepare-macos-job-image.sh"
CLEANUP_DONE=0
cleanup() { local exit_code=$?; rm -rf "$DOWNLOAD_DIR"; unset JOIN_CODE; exit "$exit_code"; }
trap cleanup EXIT INT TERM

download_verified() {
  local url="$1" expected="$2" destination="$3" name="$4" headers="$destination.headers"
  curl --silent --show-error --fail --location "${CURL_SECURITY[@]}" --dump-header "$headers" --output "$destination" "$url"
  local actual="$(shasum -a 256 "$destination" | cut -d ' ' -f 1)"; [[ "$actual" == "$expected" ]] || { echo "$name checksum mismatch: expected $expected, got $actual" >&2; return 1; }
  local response_hash="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="x-content-sha256:" {gsub("\r","",$2); print $2; exit}' "$headers")"; [[ -z "$response_hash" || "$response_hash" == "$expected" ]] || { echo "$name response hash mismatch" >&2; return 1; }; rm -f "$headers"
}
download_verified "$MARS_ORCHESTRATOR_URL" "$MARS_ORCHESTRATOR_SHA256" "$ORCHESTRATOR_STAGE" orchestrator
download_verified "$MARS_JOB_AGENT_URL" "$MARS_JOB_AGENT_SHA256" "$JOB_AGENT_STAGE" 'job agent'
download_verified "$IMAGE_PREPARATION_SCRIPT_URL" "$IMAGE_PREPARATION_SCRIPT_SHA256" "$PREPARER_STAGE" 'image preparation script'
TART_BIN="$(command -v tart 2>/dev/null || true)"; CHECK=0
mkdir -p "$APP_DIR" "$(dirname "$HOME/Library/LaunchAgents/com.mars.worker.plist")"; exec > >(tee -a "$LOG_FILE") 2>&1
write_state() { printf '{"stage":"%s","status":"%s","updatedAt":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"; }
check() { CHECK=$((CHECK + 1)); print "[$CHECK/8] $1"; write_state "$2" started; }
pass() { print "  [ok] $1"; }
check 'Installing Homebrew and Tart prerequisites' prerequisites
if [[ -z "$TART_BIN" ]]; then BREW_BIN="$(command -v brew 2>/dev/null || true)"; if [[ -z "$BREW_BIN" ]]; then NONINTERACTIVE=1 CI=1 /bin/bash -c "$(curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; BREW_BIN=/opt/homebrew/bin/brew; fi; [[ -x "$BREW_BIN" ]] || { echo 'Homebrew installation failed' >&2; exit 1; }; "$BREW_BIN" tap cirruslabs/cli; "$BREW_BIN" install cirruslabs/cli/tart; TART_BIN="$(command -v tart || echo /opt/homebrew/bin/tart)"; fi
[[ -x "$TART_BIN" ]] || { echo 'Tart is required' >&2; exit 1; }; write_state prerequisites complete; pass 'Homebrew and Tart are installed'
check 'Configuring the narrow Tart administrator permission' sudoers
if ! sudo -n "$TART_BIN" --version >/dev/null 2>&1; then sudo -v || { echo 'Administrator authorization was cancelled.' >&2; exit 1; }; SUDOERS_FILE="/etc/sudoers.d/mars-tart-${USER}"; printf '%s ALL=(root) NOPASSWD: %s\n' "$USER" "$TART_BIN" | sudo tee "$SUDOERS_FILE" >/dev/null; sudo chmod 440 "$SUDOERS_FILE"; sudo visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1 || { sudo rm -f "$SUDOERS_FILE"; echo 'Tart sudoers validation failed' >&2; exit 1; }; sudo -n "$TART_BIN" --version >/dev/null 2>&1 || { echo 'Tart is not usable with sudoers rule' >&2; exit 1; }; fi
write_state sudoers complete; pass 'Tart sudo capability configured'
check 'Preparing and verifying the local Tart job image' tart-image
LOCAL_IMAGE="${MARS_TART_LOCAL_NAME:-mars-worker-base-${TART_IMAGE_DIGEST#sha256:}}"; PREP_MANIFEST="$APP_DIR/macos-job-image-manifest.json"
"$PREPARER_STAGE" --source "$TART_IMAGE" --target "$LOCAL_IMAGE" --job-agent "$JOB_AGENT_STAGE" --output-manifest "$PREP_MANIFEST"
[[ -s "$PREP_MANIFEST" ]] || { echo 'macOS image preparation did not produce provenance' >&2; exit 1; }
PREPARED_DIGEST="$(sed -n 's/.*"preparedDigest":"\([^"]*\)".*/\1/p' "$PREP_MANIFEST")"; [[ "$PREPARED_DIGEST" == mars-macos-job@sha256:* ]] || { echo 'macOS prepared image provenance is incomplete' >&2; exit 1; }
write_state tart-image complete; pass "Prepared local Tart image: $LOCAL_IMAGE"
check 'Installing verified worker binaries' artifacts
ORCHESTRATOR="$APP_DIR/mars-orchestrator"; JOB_AGENT="$APP_DIR/mars-job-agent"; mv -f "$ORCHESTRATOR_STAGE" "$ORCHESTRATOR"; mv -f "$JOB_AGENT_STAGE" "$JOB_AGENT"; chmod 755 "$ORCHESTRATOR" "$JOB_AGENT"; write_state artifacts complete
check 'Persisting the protected one-use enrollment code' enrollment
JOIN_CODE_FILE="$APP_DIR/join-code"; IDENTITY_FILE="$APP_DIR/worker-identity.json"; [[ -f "$JOIN_CODE_FILE" ]] || { printf '%s\n' "$JOIN_CODE" > "$JOIN_CODE_FILE"; chmod 600 "$JOIN_CODE_FILE"; }; write_state enrollment complete
LAUNCHER="$APP_DIR/run-worker.sh"; PLIST="$HOME/Library/LaunchAgents/com.mars.worker.plist"; XML_LAUNCHER="${LAUNCHER//&/&amp;}"; XML_LAUNCHER="${XML_LAUNCHER//</&lt;}"; XML_LAUNCHER="${XML_LAUNCHER//>/&gt;}"; XML_LAUNCHER="${XML_LAUNCHER//\"/&quot;}"
check 'Installing the user-scoped LaunchAgent atomically' service
LAUNCHER_TMP="$LAUNCHER.tmp.$$"; PLIST_TMP="$PLIST.tmp.$$"
cat > "$LAUNCHER_TMP" <<EOF
#!/bin/zsh
set -euo pipefail
export PUBLIC_BASE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export MARS_CONTROL_PLANE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export MARS_ACTION_CACHE_ROOT=$(printf '%q' "${MARS_ACTION_CACHE_ROOT:-}")
export MARS_CACHE_PROXY_PORT=$(printf '%q' "${MARS_CACHE_PROXY_PORT:-}")
export MARS_CACHE_DATA_PORT=$(printf '%q' "${MARS_CACHE_DATA_PORT:-}")
export MARS_CACHE_PROXY_URL=$(printf '%q' "${MARS_CACHE_PROXY_URL:-}")
export MARS_CACHE_ADVERTISE_URL=$(printf '%q' "${MARS_CACHE_ADVERTISE_URL:-}")
export MARS_CACHE_TOKEN_ISSUER=$(printf '%q' "${MARS_CACHE_TOKEN_ISSUER:-}")
export MARS_CACHE_JWKS_URL=$(printf '%q' "${MARS_CACHE_JWKS_URL:-}")
export MARS_WORKER_IDENTITY_FILE=$(printf '%q' "$IDENTITY_FILE")
export MARS_JOIN_CODE_FILE=$(printf '%q' "$JOIN_CODE_FILE")
export MARS_TART_BASE_IMAGE=$(printf '%q' "$LOCAL_IMAGE")
export MARS_TART_IMAGE_DIGEST=$(printf '%q' "$PREPARED_DIGEST")
export MARS_TART_EXECUTABLE=$(printf '%q' "$TART_BIN")
if [[ -f "\$MARS_JOIN_CODE_FILE" ]]; then exec "$ORCHESTRATOR" mac-worker < "\$MARS_JOIN_CODE_FILE"; fi
unset MARS_JOIN_CODE_FILE
exec "$ORCHESTRATOR" mac-worker
EOF
chmod 755 "$LAUNCHER_TMP"; mv -f "$LAUNCHER_TMP" "$LAUNCHER"
cat > "$PLIST_TMP" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.mars.worker</string>
<key>ProgramArguments</key><array><string>$XML_LAUNCHER</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$APP_DIR/worker.log</string><key>StandardErrorPath</key><string>$APP_DIR/worker.error.log</string>
</dict></plist>
EOF
mv -f "$PLIST_TMP" "$PLIST"; write_state service complete
check 'Starting the worker LaunchAgent' startup
launchctl bootout "gui/$UID/com.mars.worker" >/dev/null 2>&1 || true; launchctl bootstrap "gui/$UID" "$PLIST"; launchctl kickstart -k "gui/$UID/com.mars.worker"; write_state complete complete; CLEANUP_DONE=1; pass 'Worker started; join-code remains until authenticated'
