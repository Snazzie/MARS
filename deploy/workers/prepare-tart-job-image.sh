#!/bin/zsh
set -euo pipefail
setopt EXTENDED_GLOB

RUNNER_VERSION="2.336.0"
RUNNER_SHA256="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
PLATFORM="macos-arm64"
RUNNER_ARCHIVE_INPUT=""
TART_BIN="${TART_BIN:-tart}"
CURL_BIN="${CURL_BIN:-curl}"
SOURCE=""
TARGET=""
JOB_AGENT=""
OUTPUT_MANIFEST=""

usage() {
  print -u2 "usage: $0 --platform macos-arm64|linux-arm64 --source <digest-pinned-oci-image> --target <content-addressed-local-name> --job-agent <compiled-binary> [--runner-archive <runner.tar.gz>] --output-manifest <path>"
  exit 2
}
while (( $# > 0 )); do
  case "$1" in
    --platform) (( $# >= 2 )) || usage; PLATFORM="$2"; shift 2 ;;
    --source) (( $# >= 2 )) || usage; SOURCE="$2"; shift 2 ;;
    --target) (( $# >= 2 )) || usage; TARGET="$2"; shift 2 ;;
    --job-agent) (( $# >= 2 )) || usage; JOB_AGENT="$2"; shift 2 ;;
    --runner-archive) (( $# >= 2 )) || usage; RUNNER_ARCHIVE_INPUT="$2"; shift 2 ;;
    --output-manifest) (( $# >= 2 )) || usage; OUTPUT_MANIFEST="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$PLATFORM" == "macos-arm64" || "$PLATFORM" == "linux-arm64" ]] || usage
if [[ "$PLATFORM" == "linux-arm64" ]]; then
  [[ -n "$RUNNER_ARCHIVE_INPUT" && -f "$RUNNER_ARCHIVE_INPUT" ]] || { print -u2 "linux-arm64 requires --runner-archive"; exit 2; }
  RUNNER_URL="bundled:${RUNNER_ARCHIVE_INPUT}"
  RUNNER_SHA256="$(shasum -a 256 "$RUNNER_ARCHIVE_INPUT" | cut -d ' ' -f 1)"
fi
[[ -n "$SOURCE" && -n "$TARGET" && -n "$JOB_AGENT" && -n "$OUTPUT_MANIFEST" ]] || usage
[[ "$SOURCE" =~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$' ]] || { print -u2 "source must be a full lowercase digest-pinned OCI reference"; exit 2; }
SOURCE_DIGEST="${SOURCE##*@}"
EXPECTED_TARGET="mars-worker-${PLATFORM}-base-${SOURCE_DIGEST#sha256:}"
[[ "$TARGET" == "$EXPECTED_TARGET" ]] || { print -u2 "target must be content-addressed as $EXPECTED_TARGET"; exit 2; }
[[ "$JOB_AGENT" == /* && -x "$JOB_AGENT" ]] || { print -u2 "job agent must be a compiled executable"; exit 2; }

function tart() { command "$TART_BIN" "$@"; }
PREPARATION_SCRIPT_SHA256="$(shasum -a 256 "$0" | cut -d ' ' -f 1)"
JOB_AGENT_SHA256="$(shasum -a 256 "$JOB_AGENT" | cut -d ' ' -f 1)"
PROVENANCE="{\"platform\":\"$PLATFORM\",\"source\":\"$SOURCE\",\"sourceDigest\":\"$SOURCE_DIGEST\",\"jobAgentSha256\":\"$JOB_AGENT_SHA256\",\"runnerUrl\":\"$RUNNER_URL\",\"runnerVersion\":\"$RUNNER_VERSION\",\"runnerSha256\":\"$RUNNER_SHA256\",\"preparationScriptSha256\":\"$PREPARATION_SCRIPT_SHA256\",\"localTarget\":\"$TARGET\"}"
PROVENANCE_DIGEST="$(print -rn -- "$PROVENANCE" | shasum -a 256 | cut -d ' ' -f 1)"
PREPARED_DIGEST="mars-${PLATFORM}-job@sha256:${PROVENANCE_DIGEST}"
EXPECTED_MANIFEST="{\"platform\":\"$PLATFORM\",\"source\":\"$SOURCE\",\"sourceDigest\":\"$SOURCE_DIGEST\",\"jobAgentSha256\":\"$JOB_AGENT_SHA256\",\"runnerUrl\":\"$RUNNER_URL\",\"runnerVersion\":\"$RUNNER_VERSION\",\"runnerSha256\":\"$RUNNER_SHA256\",\"preparationScriptSha256\":\"$PREPARATION_SCRIPT_SHA256\",\"localTarget\":\"$TARGET\",\"preparedDigest\":\"$PREPARED_DIGEST\"}"

local_target_exists() { tart list --source local --quiet 2>/dev/null | grep -Fxq -- "$TARGET"; }
# A complete manifest and local target are the reusable unit. No registry pull or
# Tart mutation occurs when provenance still matches exactly.
if [[ -f "$OUTPUT_MANIFEST" ]] && local_target_exists && [[ "$(cat "$OUTPUT_MANIFEST")" == "$EXPECTED_MANIFEST" ]]; then
  if [[ "$PLATFORM" == "macos-arm64" ]]; then
    print -r -- "MARS_TART_MACOS_BASE_IMAGE=$TARGET"
    print -r -- "MARS_TART_MACOS_IMAGE_DIGEST=$PREPARED_DIGEST"
  else
    print -r -- "MARS_TART_LINUX_ARM64_BASE_IMAGE=$TARGET"
    print -r -- "MARS_TART_LINUX_ARM64_IMAGE_DIGEST=$PREPARED_DIGEST"
  fi
  exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mars-image.XXXXXX")"
RUNNER_ARCHIVE="$TMP_DIR/actions-runner.tar.gz"
MANIFEST="$TMP_DIR/image-manifest.json"
STAGING_TARGET="${TARGET}-staging-${PROVENANCE_DIGEST[1,12]}"
BACKUP_TARGET="${TARGET}-previous-${RANDOM}"
RUN_PID=""
CREATED=0
SWAPPED=0

cleanup() {
  local exit_code=$?
  if (( SWAPPED == 1 )); then
    tart delete "$TARGET" >/dev/null 2>&1 || true
    tart rename "$BACKUP_TARGET" "$TARGET" >/dev/null 2>&1 || true
  fi
  if (( CREATED == 1 )); then
    tart stop "$STAGING_TARGET" >/dev/null 2>&1 || true
    [[ -z "$RUN_PID" ]] || wait "$RUN_PID" >/dev/null 2>&1 || true
    tart delete "$STAGING_TARGET" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

if [[ "$PLATFORM" == "linux-arm64" ]]; then
  cp "$RUNNER_ARCHIVE_INPUT" "$RUNNER_ARCHIVE"
else
  "$CURL_BIN" --fail --location --silent --show-error "$RUNNER_URL" --output "$RUNNER_ARCHIVE"
fi
print -r -- "$RUNNER_SHA256  $RUNNER_ARCHIVE" | shasum -a 256 -c - >/dev/null
printf '%s\n' "$PROVENANCE" > "$MANIFEST"

# Build only a staging VM. The previously active target is untouched until the
# full boot, injection, and runtime verification below succeeds.
tart clone "$SOURCE" "$STAGING_TARGET"
CREATED=1
tart run --no-graphics "$STAGING_TARGET" >"$TMP_DIR/tart-run.log" 2>&1 &
RUN_PID=$!
READY=0
for _ in {1..120}; do
  if tart exec "$STAGING_TARGET" /usr/bin/true >/dev/null 2>&1; then READY=1; break; fi
  kill -0 "$RUN_PID" >/dev/null 2>&1 || { print -u2 "prepared image failed to boot"; exit 1; }
  sleep 2
done
(( READY == 1 )) || { print -u2 "timed out waiting for prepared image"; exit 1; }
[[ "$PLATFORM" == "macos-arm64" ]] && tart exec "$STAGING_TARGET" /bin/test ! -e /opt/actions-runner || true
RUNNER_SHELL="/bin/bash"
[[ "$PLATFORM" == "macos-arm64" ]] && RUNNER_SHELL="/bin/zsh"
tart exec -i "$STAGING_TARGET" "$RUNNER_SHELL" -c 'set -euo pipefail; rm -rf /tmp/mars-actions-runner; mkdir -p /tmp/mars-actions-runner; /usr/bin/tar -xzf - -C /tmp/mars-actions-runner' < "$RUNNER_ARCHIVE"
tart exec -i "$STAGING_TARGET" "$RUNNER_SHELL" -c 'set -euo pipefail; umask 077; /bin/cat > /tmp/mars-job-agent' < "$JOB_AGENT"
tart exec -i "$STAGING_TARGET" "$RUNNER_SHELL" -c 'set -euo pipefail; umask 077; /bin/cat > /tmp/mars-image-manifest.json' < "$MANIFEST"
tart exec "$STAGING_TARGET" /usr/bin/sudo /bin/mkdir -p /opt /etc/mars /usr/local/bin
if [[ "$PLATFORM" == "linux-arm64" ]]; then tart exec "$STAGING_TARGET" /usr/bin/sudo /opt/actions-runner/bin/installdependencies.sh; fi
tart exec "$STAGING_TARGET" /usr/bin/sudo /bin/mv /tmp/mars-actions-runner /opt/actions-runner
tart exec "$STAGING_TARGET" /usr/bin/sudo /usr/bin/install -m 0755 /tmp/mars-job-agent /usr/local/bin/mars-job-agent
tart exec "$STAGING_TARGET" /usr/bin/sudo /usr/bin/install -m 0644 /tmp/mars-image-manifest.json /etc/mars/image-manifest.json
tart exec "$STAGING_TARGET" /bin/test -x /opt/actions-runner/run.sh
tart exec "$STAGING_TARGET" /bin/test -x /usr/local/bin/mars-job-agent
tart exec "$STAGING_TARGET" /opt/actions-runner/bin/Runner.Listener --version | while IFS= read -r version; do [[ "$version" == "$RUNNER_VERSION" ]] || { print -u2 "unexpected Actions Runner version"; exit 1; }; done
if [[ "$PLATFORM" == "linux-arm64" ]]; then
  tart exec "$STAGING_TARGET" /bin/sh -c 'test "$(uname -s)" = Linux && test "$(uname -m)" = aarch64'
else
  tart exec "$STAGING_TARGET" /bin/sh -c 'test "$(uname -s)" = Darwin && test "$(uname -m)" = arm64'
fi
tart stop "$STAGING_TARGET"
wait "$RUN_PID" >/dev/null 2>&1 || true
RUN_PID=""

manifest_parent="$(dirname "$OUTPUT_MANIFEST")"; mkdir -p "$manifest_parent"
manifest_tmp="$OUTPUT_MANIFEST.tmp.$$"
printf '%s\n' "$EXPECTED_MANIFEST" > "$manifest_tmp"
if local_target_exists; then tart rename "$TARGET" "$BACKUP_TARGET"; fi
SWAPPED=1
tart rename "$STAGING_TARGET" "$TARGET"
CREATED=0
mv -f "$manifest_tmp" "$OUTPUT_MANIFEST"
tart delete "$BACKUP_TARGET" >/dev/null 2>&1 || true
SWAPPED=0
if [[ "$PLATFORM" == "macos-arm64" ]]; then
  print -r -- "MARS_TART_MACOS_BASE_IMAGE=$TARGET"
  print -r -- "MARS_TART_MACOS_IMAGE_DIGEST=$PREPARED_DIGEST"
else
  print -r -- "MARS_TART_LINUX_ARM64_BASE_IMAGE=$TARGET"
  print -r -- "MARS_TART_LINUX_ARM64_IMAGE_DIGEST=$PREPARED_DIGEST"
fi
