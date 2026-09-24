#!/bin/zsh
set -euo pipefail
umask 077

usage() { echo "usage: $0 [--code ENROLLMENT_CODE] [--upgrade] [--control-plane-url URL]" >&2; exit 2; }
parse_args() {
  JOIN_CODE=""; CONTROL_PLANE_URL="${PUBLIC_BASE_URL:-}"; CONTROL_PLANE_URL_ARG=""; UPGRADE=0; local had_args=$#
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --code) [[ $# -ge 2 && -z "$JOIN_CODE" && -n "$2" && "$UPGRADE" -eq 0 ]] || usage; JOIN_CODE="$2"; shift 2 ;;
      --upgrade) [[ "$UPGRADE" -eq 0 ]] || usage; UPGRADE=1; shift ;;
      --control-plane-url) [[ $# -ge 2 && -z "$CONTROL_PLANE_URL_ARG" && -n "$2" ]] || usage; CONTROL_PLANE_URL_ARG="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
  if [[ "$UPGRADE" -eq 0 && -z "$JOIN_CODE" && "$had_args" -eq 0 && -t 0 ]]; then read -r -s 'JOIN_CODE?Mars enrollment code: '; print >&2; fi
  if [[ "$UPGRADE" -eq 0 ]]; then [[ "$JOIN_CODE" =~ ^[A-Za-z0-9_-]{43}$ ]] || usage; else [[ -z "$JOIN_CODE" ]] || usage; fi
  [[ -z "$CONTROL_PLANE_URL_ARG" ]] || CONTROL_PLANE_URL="$CONTROL_PLANE_URL_ARG"
  PUBLIC_BASE_URL="$CONTROL_PLANE_URL"
}
parse_args "$@"
ARTIFACT_BASE_URL="${MARS_ARTIFACT_BASE_URL:-}"
require_config() {
  [[ -n "${PUBLIC_BASE_URL:-}" ]] || { echo 'PUBLIC_BASE_URL is required' >&2; exit 1; }
  [[ -n "${MARS_WORKER_VERSION:-}" ]] || { echo 'MARS_WORKER_VERSION is required' >&2; exit 1; }
  [[ -n "${MARS_WORKER_CONTRACT_VERSION:-}" ]] || { echo 'MARS_WORKER_CONTRACT_VERSION is required' >&2; exit 1; }
  [[ -n "${MARS_ORCHESTRATOR_URL:-}" ]] || { echo 'MARS_ORCHESTRATOR_URL is required' >&2; exit 1; }
  [[ -n "${MARS_ORCHESTRATOR_SHA256:-}" ]] || { echo 'MARS_ORCHESTRATOR_SHA256 is required' >&2; exit 1; }
  [[ -n "${MARS_MACOS_JOB_AGENT_URL:-}" && -n "${MARS_MACOS_JOB_AGENT_SHA256:-}" ]] || { echo 'macOS job agent is required' >&2; exit 1; }
  [[ -n "${MARS_LINUX_ARM64_JOB_AGENT_URL:-}" && -n "${MARS_LINUX_ARM64_JOB_AGENT_SHA256:-}" ]] || { echo 'Linux ARM64 job agent is required' >&2; exit 1; }
  [[ -n "${MARS_LINUX_ARM64_RUNNER_URL:-}" && -n "${MARS_LINUX_ARM64_RUNNER_SHA256:-}" ]] || { echo 'Linux ARM64 runner is required' >&2; exit 1; }
  [[ -n "${IMAGE_PREPARATION_SCRIPT_URL:-}" && -n "${IMAGE_PREPARATION_SCRIPT_SHA256:-}" ]] || { echo 'Tart image preparation script is required' >&2; exit 1; }
  [[ -n "${MARS_MACOS_STATUS_ITEM_URL:-}" && -n "${MARS_MACOS_STATUS_ITEM_SHA256:-}" ]] || { echo 'macOS status item is required' >&2; exit 1; }
  [[ -n "${TART_MACOS_IMAGE:-}" && -n "${TART_LINUX_ARM64_IMAGE:-}" ]] || { echo 'both Tart source images are required' >&2; exit 1; }
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
  [[ "$MARS_WORKER_VERSION" =~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ]] || { echo 'MARS_WORKER_VERSION must use major.minor.patch' >&2; exit 1; }
  [[ "$MARS_WORKER_CONTRACT_VERSION" =~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ]] || { echo 'MARS_WORKER_CONTRACT_VERSION must use major.minor.patch' >&2; exit 1; }
  validate_http_url "$PUBLIC_BASE_URL" PUBLIC_BASE_URL origin || exit 1
  local artifact_origin="$URL_ORIGIN"
  if [[ -n "$ARTIFACT_BASE_URL" ]]; then ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL%/}"; validate_http_url "$ARTIFACT_BASE_URL" MARS_ARTIFACT_BASE_URL origin || exit 1; artifact_origin="$URL_ORIGIN"; fi
  for pair in "MARS_ORCHESTRATOR_URL:$MARS_ORCHESTRATOR_URL" "MARS_MACOS_JOB_AGENT_URL:$MARS_MACOS_JOB_AGENT_URL" "MARS_LINUX_ARM64_JOB_AGENT_URL:$MARS_LINUX_ARM64_JOB_AGENT_URL" "MARS_LINUX_ARM64_RUNNER_URL:$MARS_LINUX_ARM64_RUNNER_URL" "IMAGE_PREPARATION_SCRIPT_URL:$IMAGE_PREPARATION_SCRIPT_URL" "MARS_MACOS_STATUS_ITEM_URL:$MARS_MACOS_STATUS_ITEM_URL"; do local name="${pair%%:*}" url="${pair#*:}"; validate_http_url "$url" "$name" asset || exit 1; done
  for pair in "MARS_ORCHESTRATOR_SHA256:$MARS_ORCHESTRATOR_SHA256" "MARS_MACOS_JOB_AGENT_SHA256:$MARS_MACOS_JOB_AGENT_SHA256" "MARS_LINUX_ARM64_JOB_AGENT_SHA256:$MARS_LINUX_ARM64_JOB_AGENT_SHA256" "MARS_LINUX_ARM64_RUNNER_SHA256:$MARS_LINUX_ARM64_RUNNER_SHA256" "IMAGE_PREPARATION_SCRIPT_SHA256:$IMAGE_PREPARATION_SCRIPT_SHA256" "MARS_MACOS_STATUS_ITEM_SHA256:$MARS_MACOS_STATUS_ITEM_SHA256"; do local name="${pair%%:*}" hash="${pair#*:}"; [[ "$hash" =~ '^[0-9a-f]{64}$' ]] || { echo "$name must be a lowercase SHA-256 value" >&2; exit 1; }; done
  validate_oci_digest "$TART_MACOS_IMAGE" TART_MACOS_IMAGE; validate_oci_digest "$TART_LINUX_ARM64_IMAGE" TART_LINUX_ARM64_IMAGE
}
validate_config
CURL_SECURITY=()
trap 'unset JOIN_CODE CONTROL_PLANE_URL_ARG' EXIT
[[ "$EUID" -ne 0 ]] || { echo 'Run this installer as the logged-in user, not with sudo.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS is required' >&2; exit 1; }
[[ "$(uname -m)" == arm64 ]] || { echo 'macOS 14+ arm64 is required' >&2; exit 1; }
MACOS_VERSION="$(sw_vers -productVersion)"; MACOS_MAJOR="${MACOS_VERSION%%.*}"; [[ "$MACOS_MAJOR" -ge 14 ]] || { echo 'macOS 14 or newer is required' >&2; exit 1; }
curl --silent --show-error --fail --max-time 20 --location "${CURL_SECURITY[@]}" "${PUBLIC_BASE_URL%/}/api/healthz" >/dev/null

DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mars-worker.XXXXXX")"
APP_DIR="$HOME/Library/Application Support/Mars"; STATE_FILE="$APP_DIR/install-state.json"; LOG_FILE="$APP_DIR/install.log"
ORCHESTRATOR_STAGE="$DOWNLOAD_DIR/mars-orchestrator"; MACOS_JOB_AGENT_STAGE="$DOWNLOAD_DIR/mars-macos-job-agent"; LINUX_JOB_AGENT_STAGE="$DOWNLOAD_DIR/mars-linux-arm64-job-agent"; LINUX_RUNNER_STAGE="$DOWNLOAD_DIR/runner.tar.gz"; PREPARER_STAGE="$DOWNLOAD_DIR/prepare-tart-job-image.sh"; STATUS_ITEM_STAGE="$DOWNLOAD_DIR/mars-status-item"; ICON_STAGE="$DOWNLOAD_DIR/mars-icon.png"
if [[ "$UPGRADE" -eq 1 ]]; then
  [[ -x "$APP_DIR/mars-orchestrator" && -s "$APP_DIR/worker-identity.json" ]] || { echo 'Upgrade requires an existing macOS worker identity.' >&2; exit 1; }
fi
cleanup() { local exit_code=$?; rm -rf "$DOWNLOAD_DIR"; unset JOIN_CODE; exit "$exit_code"; }
trap cleanup EXIT INT TERM

download_verified() {
  local url="$1" expected="$2" destination="$3" name="$4" security=()
  local headers="$destination.headers"
  [[ "$url" == https://* ]] && security=(--proto '=https' --tlsv1.2)
  curl --silent --show-error --fail --max-time 300 --location "${security[@]}" --dump-header "$headers" --output "$destination" "$url"
  local actual="$(shasum -a 256 "$destination" | cut -d ' ' -f 1)"; [[ "$actual" == "$expected" ]] || { echo "$name checksum mismatch: expected $expected, got $actual" >&2; return 1; }
  local response_hash=""; [[ -f "$headers" ]] && response_hash="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="x-content-sha256:" {gsub("\r","",$2); print $2; exit}' "$headers")"; [[ -z "$response_hash" || "$response_hash" == "$expected" ]] || { echo "$name response hash mismatch" >&2; return 1; }; rm -f "$headers"
}
download_verified "$MARS_ORCHESTRATOR_URL" "$MARS_ORCHESTRATOR_SHA256" "$ORCHESTRATOR_STAGE" orchestrator
download_verified "$MARS_MACOS_JOB_AGENT_URL" "$MARS_MACOS_JOB_AGENT_SHA256" "$MACOS_JOB_AGENT_STAGE" 'macOS job agent'
download_verified "$MARS_LINUX_ARM64_JOB_AGENT_URL" "$MARS_LINUX_ARM64_JOB_AGENT_SHA256" "$LINUX_JOB_AGENT_STAGE" 'Linux ARM64 job agent'
download_verified "$MARS_LINUX_ARM64_RUNNER_URL" "$MARS_LINUX_ARM64_RUNNER_SHA256" "$LINUX_RUNNER_STAGE" 'Linux ARM64 runner'
download_verified "$IMAGE_PREPARATION_SCRIPT_URL" "$IMAGE_PREPARATION_SCRIPT_SHA256" "$PREPARER_STAGE" 'image preparation script'
download_verified "$MARS_MACOS_STATUS_ITEM_URL" "$MARS_MACOS_STATUS_ITEM_SHA256" "$STATUS_ITEM_STAGE" 'macOS status item'
curl --silent --show-error --fail --location "${PUBLIC_BASE_URL%/}/mars-icon.svg" -o "$DOWNLOAD_DIR/mars-icon.svg"
sips -s format png "$DOWNLOAD_DIR/mars-icon.svg" --out "$ICON_STAGE" >/dev/null
chmod +x "$ORCHESTRATOR_STAGE" "$MACOS_JOB_AGENT_STAGE" "$LINUX_JOB_AGENT_STAGE" "$PREPARER_STAGE" "$STATUS_ITEM_STAGE"
for executable in "$ORCHESTRATOR_STAGE" "$MACOS_JOB_AGENT_STAGE" "$STATUS_ITEM_STAGE"; do
  codesign --force --sign - --timestamp=none "$executable"
  codesign --verify --deep --strict "$executable"
done
CHECK=0
write_state() {
  local stage="$1" state_status="$2" updated_at state_tmp
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$APP_DIR"
  state_tmp="$STATE_FILE.tmp.$$"
  printf '{"stage":"%s","status":"%s","updatedAt":"%s"}\n' "$stage" "$state_status" "$updated_at" > "$state_tmp"
  chmod 600 "$state_tmp"
  mv -f "$state_tmp" "$STATE_FILE"
  printf '[%s] %s %s\n' "$updated_at" "$stage" "$state_status" >> "$LOG_FILE"
}
check() { CHECK=$((CHECK + 1)); print "[$CHECK/8] $1"; write_state "$2" started; }
pass() { print "  [ok] $1"; }
TART_BIN="${TART_BIN:-$(command -v tart 2>/dev/null || true)}"
check 'Installing Homebrew and Tart prerequisites' prerequisites
if [[ -z "$TART_BIN" ]]; then BREW_BIN="$(command -v brew 2>/dev/null || true)"; if [[ -z "$BREW_BIN" ]]; then NONINTERACTIVE=1 CI=1 /bin/bash -c "$(curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; BREW_BIN=/opt/homebrew/bin/brew; fi; [[ -x "$BREW_BIN" ]] || { echo 'Homebrew installation failed' >&2; exit 1; }; "$BREW_BIN" tap cirruslabs/cli; "$BREW_BIN" install cirruslabs/cli/tart; TART_BIN="$(command -v tart || echo /opt/homebrew/bin/tart)"; fi
[[ -x "$TART_BIN" ]] || { echo 'Tart is required' >&2; exit 1; }; write_state prerequisites complete; pass 'Homebrew and Tart are installed'
if ! sudo -n "$TART_BIN" --version >/dev/null 2>&1; then sudo -v || { echo 'Administrator authorization was cancelled.' >&2; exit 1; }; SUDOERS_FILE="/etc/sudoers.d/mars-tart-${USER}"; printf '%s ALL=(root) NOPASSWD: %s\n' "$USER" "$TART_BIN" | sudo tee "$SUDOERS_FILE" >/dev/null; sudo chmod 440 "$SUDOERS_FILE"; sudo visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1 || { sudo rm -f "$SUDOERS_FILE"; echo 'Tart sudoers validation failed' >&2; exit 1; }; sudo -n "$TART_BIN" --version >/dev/null 2>&1 || { echo 'Tart is not usable with sudoers rule' >&2; exit 1; }; fi
write_state sudoers complete; pass 'Tart sudo capability configured'
check 'Preparing and verifying both local Tart job images' tart-image
MACOS_IMAGE="mars-worker-macos-arm64-base-${TART_MACOS_IMAGE##*@sha256:}"; LINUX_IMAGE="mars-worker-linux-arm64-base-${TART_LINUX_ARM64_IMAGE##*@sha256:}"
MACOS_MANIFEST="$APP_DIR/macos-tart-image-manifest.json"; LINUX_MANIFEST="$APP_DIR/linux-arm64-tart-image-manifest.json"
TART_BIN="$TART_BIN" "$PREPARER_STAGE" --platform macos-arm64 --source "$TART_MACOS_IMAGE" --target "$MACOS_IMAGE" --job-agent "$MACOS_JOB_AGENT_STAGE" --output-manifest "$MACOS_MANIFEST"
TART_BIN="$TART_BIN" "$PREPARER_STAGE" --platform linux-arm64 --source "$TART_LINUX_ARM64_IMAGE" --target "$LINUX_IMAGE" --job-agent "$LINUX_JOB_AGENT_STAGE" --runner-archive "$LINUX_RUNNER_STAGE" --output-manifest "$LINUX_MANIFEST"
[[ -s "$MACOS_MANIFEST" && -s "$LINUX_MANIFEST" ]] || { echo 'Tart image preparation did not produce provenance' >&2; exit 1; }
MACOS_PREPARED_DIGEST="$(sed -n 's/.*"preparedDigest":"\([^"]*\)".*/\1/p' "$MACOS_MANIFEST")"; LINUX_PREPARED_DIGEST="$(sed -n 's/.*"preparedDigest":"\([^"]*\)".*/\1/p' "$LINUX_MANIFEST")"
[[ "$MACOS_PREPARED_DIGEST" == mars-macos-arm64-job@sha256:* && "$LINUX_PREPARED_DIGEST" == mars-linux-arm64-job@sha256:* ]] || { echo 'Tart prepared image provenance is incomplete' >&2; exit 1; }
write_state tart-image complete; pass "Prepared local Tart images: $MACOS_IMAGE and $LINUX_IMAGE"
launchctl bootout "gui/$UID/com.mars.worker" >/dev/null 2>&1 || true
ORCHESTRATOR="$APP_DIR/mars-orchestrator"; MACOS_JOB_AGENT="$APP_DIR/mars-macos-job-agent"; LINUX_JOB_AGENT="$APP_DIR/mars-linux-arm64-job-agent"; STATUS_ITEM="$APP_DIR/mars-status-item"; ICON="$APP_DIR/mars-icon.png"; mv -f "$ORCHESTRATOR_STAGE" "$ORCHESTRATOR"; mv -f "$MACOS_JOB_AGENT_STAGE" "$MACOS_JOB_AGENT"; mv -f "$LINUX_JOB_AGENT_STAGE" "$LINUX_JOB_AGENT"; mv -f "$STATUS_ITEM_STAGE" "$STATUS_ITEM"; mv -f "$ICON_STAGE" "$ICON"; chmod 755 "$ORCHESTRATOR" "$MACOS_JOB_AGENT" "$LINUX_JOB_AGENT" "$STATUS_ITEM"; write_state artifacts complete
check 'Persisting the protected one-use enrollment code' enrollment
JOIN_CODE_FILE="$APP_DIR/join-code"; IDENTITY_FILE="$APP_DIR/worker-identity.json"
if [[ "$UPGRADE" -eq 0 ]]; then
  rm -f "$IDENTITY_FILE"
  JOIN_CODE_TMP="$JOIN_CODE_FILE.tmp.$$"
  printf '%s\n' "$JOIN_CODE" > "$JOIN_CODE_TMP"
  chmod 600 "$JOIN_CODE_TMP"
  mv -f "$JOIN_CODE_TMP" "$JOIN_CODE_FILE"
else
  [[ -s "$IDENTITY_FILE" ]] || { echo 'Worker identity disappeared during upgrade.' >&2; exit 1; }
  JOIN_CODE_FILE=""
fi
write_state enrollment complete
LAUNCHER="$APP_DIR/run-worker.sh"; PLIST="$HOME/Library/LaunchAgents/com.mars.worker.plist"; XML_LAUNCHER="${LAUNCHER//&/&amp;}"; XML_LAUNCHER="${XML_LAUNCHER//</&lt;}"; XML_LAUNCHER="${XML_LAUNCHER//>/&gt;}"; XML_LAUNCHER="${XML_LAUNCHER//\"/&quot;}"
mkdir -p "$(dirname "$PLIST")"
check 'Installing the user-scoped LaunchAgent atomically' service
LAUNCHER_TMP="$LAUNCHER.tmp.$$"; PLIST_TMP="$PLIST.tmp.$$"
cat > "$LAUNCHER_TMP" <<EOF
#!/bin/zsh
set -euo pipefail
export PUBLIC_BASE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export MARS_CONTROL_PLANE_URL=$(printf '%q' "$PUBLIC_BASE_URL")
export MARS_WORKER_VERSION=$(printf '%q' "$MARS_WORKER_VERSION")
export MARS_WORKER_CONTRACT_VERSION=$(printf '%q' "$MARS_WORKER_CONTRACT_VERSION")
export MARS_ACTION_CACHE_ROOT=$(printf '%q' "${MARS_ACTION_CACHE_ROOT:-}")
export MARS_CACHE_PROXY_PORT=$(printf '%q' "${MARS_CACHE_PROXY_PORT:-}")
export MARS_CACHE_DATA_PORT=$(printf '%q' "${MARS_CACHE_DATA_PORT:-}")
export MARS_CACHE_PROXY_URL=$(printf '%q' "${MARS_CACHE_PROXY_URL:-}")
export MARS_CACHE_ADVERTISE_URL=$(printf '%q' "${MARS_CACHE_ADVERTISE_URL:-}")
export MARS_CACHE_TOKEN_ISSUER=$(printf '%q' "${MARS_CACHE_TOKEN_ISSUER:-}")
export MARS_CACHE_JWKS_URL=$(printf '%q' "${MARS_CACHE_JWKS_URL:-}")
export MARS_WORKER_IDENTITY_FILE=$(printf '%q' "$IDENTITY_FILE")
export MARS_JOIN_CODE_FILE=$(printf '%q' "$JOIN_CODE_FILE")
export MARS_TART_MACOS_BASE_IMAGE=$(printf '%q' "$MACOS_IMAGE")
export MARS_TART_MACOS_IMAGE_DIGEST=$(printf '%q' "$MACOS_PREPARED_DIGEST")
export MARS_TART_LINUX_ARM64_BASE_IMAGE=$(printf '%q' "$LINUX_IMAGE")
export MARS_TART_LINUX_ARM64_IMAGE_DIGEST=$(printf '%q' "$LINUX_PREPARED_DIGEST")
export MARS_MACOS_STATUS_ITEM_EXECUTABLE=$(printf '%q' "$STATUS_ITEM")
export MARS_MACOS_STATUS_ITEM_ICON=$(printf '%q' "$ICON")
export MARS_LEASE_PICKUP_STATE_FILE=$(printf '%q' "$APP_DIR/lease-pickup.json")
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
sleep 1; launchctl bootstrap "gui/$UID" "$PLIST" || { sleep 2; launchctl bootstrap "gui/$UID" "$PLIST"; }; launchctl kickstart -k "gui/$UID/com.mars.worker"; write_state complete complete; CLEANUP_DONE=1
if [[ "$UPGRADE" -eq 1 ]]; then pass 'Worker images and runtime upgraded; identity preserved'; else pass 'Worker started; join-code remains until authenticated'; fi
