#!/bin/zsh
set -euo pipefail
setopt EXTENDED_GLOB

RUNNER_VERSION="2.336.0"
RUNNER_SHA256="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
TART_BIN="${TART_BIN:-tart}"
CURL_BIN="${CURL_BIN:-curl}"
SOURCE=""
TARGET=""
JOB_AGENT=""

usage() {
  print -u2 "usage: $0 --source <immutable-tart-image> --target <new-local-name> --job-agent <compiled-binary>"
  exit 2
}

while (( $# > 0 )); do
  case "$1" in
    --source) (( $# >= 2 )) || usage; SOURCE="$2"; shift 2 ;;
    --target) (( $# >= 2 )) || usage; TARGET="$2"; shift 2 ;;
    --job-agent) (( $# >= 2 )) || usage; JOB_AGENT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$SOURCE" && -n "$TARGET" && -n "$JOB_AGENT" ]] || usage
[[ "$SOURCE" == [A-Za-z0-9./:@_-]## ]] || { print -u2 "invalid source image"; exit 2; }
[[ "$TARGET" == [A-Za-z0-9._-]## ]] || { print -u2 "invalid target image"; exit 2; }
[[ -x "$JOB_AGENT" ]] || { print -u2 "job agent must be a compiled executable"; exit 2; }

function tart() { command "$TART_BIN" "$@"; }

while IFS= read -r image; do
  [[ "$image" != "$TARGET" ]] || { print -u2 "target already exists: $TARGET"; exit 1; }
done < <(tart list --source local --quiet)

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/whitesmith-image.XXXXXX")"
RUNNER_ARCHIVE="$TMP_DIR/actions-runner.tar.gz"
MANIFEST="$TMP_DIR/image-manifest.json"
RUN_PID=""
CREATED=0
SUCCEEDED=0

cleanup() {
  local exit_code=$?
  if (( SUCCEEDED == 0 && CREATED == 1 )); then
    tart stop "$TARGET" >/dev/null 2>&1 || true
    [[ -z "$RUN_PID" ]] || wait "$RUN_PID" >/dev/null 2>&1 || true
    tart delete "$TARGET" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

"$CURL_BIN" --fail --location --silent --show-error "$RUNNER_URL" --output "$RUNNER_ARCHIVE"
print -r -- "$RUNNER_SHA256  $RUNNER_ARCHIVE" | shasum -a 256 -c - >/dev/null
JOB_AGENT_SHA256="$(shasum -a 256 "$JOB_AGENT" | cut -d ' ' -f 1)"
printf '{"jobAgentSha256":"%s","runnerArchiveSha256":"%s","runnerVersion":"%s","source":"%s"}\n' \
  "$JOB_AGENT_SHA256" "$RUNNER_SHA256" "$RUNNER_VERSION" "$SOURCE" > "$MANIFEST"
MANIFEST_SHA256="$(shasum -a 256 "$MANIFEST" | cut -d ' ' -f 1)"
LOGICAL_DIGEST="whitesmith-macos-job@sha256:${MANIFEST_SHA256}"

tart clone "$SOURCE" "$TARGET"
CREATED=1
tart run --no-graphics "$TARGET" >"$TMP_DIR/tart-run.log" 2>&1 &
RUN_PID=$!

READY=0
for _ in {1..120}; do
  if tart exec "$TARGET" /usr/bin/true >/dev/null 2>&1; then READY=1; break; fi
  kill -0 "$RUN_PID" >/dev/null 2>&1 || { print -u2 "prepared image failed to boot"; exit 1; }
  sleep 2
done
(( READY == 1 )) || { print -u2 "timed out waiting for prepared image"; exit 1; }

tart exec "$TARGET" /bin/test ! -e /opt/actions-runner
tart exec -i "$TARGET" /bin/zsh -c 'set -euo pipefail; rm -rf /tmp/whitesmith-actions-runner; mkdir -p /tmp/whitesmith-actions-runner; /usr/bin/tar -xzf - -C /tmp/whitesmith-actions-runner' < "$RUNNER_ARCHIVE"
tart exec -i "$TARGET" /bin/zsh -c 'set -euo pipefail; umask 077; /bin/cat > /tmp/whitesmith-job-agent' < "$JOB_AGENT"
tart exec -i "$TARGET" /bin/zsh -c 'set -euo pipefail; umask 077; /bin/cat > /tmp/whitesmith-image-manifest.json' < "$MANIFEST"
tart exec "$TARGET" /usr/bin/sudo /bin/mkdir -p /opt /etc/whitesmith /usr/local/bin
tart exec "$TARGET" /usr/bin/sudo /bin/mv /tmp/whitesmith-actions-runner /opt/actions-runner
tart exec "$TARGET" /usr/bin/sudo /usr/bin/install -m 0755 /tmp/whitesmith-job-agent /usr/local/bin/whitesmith-job-agent
tart exec "$TARGET" /usr/bin/sudo /usr/bin/install -m 0644 /tmp/whitesmith-image-manifest.json /etc/whitesmith/image-manifest.json
tart exec "$TARGET" /bin/test -x /opt/actions-runner/run.sh
tart exec "$TARGET" /bin/test -x /usr/local/bin/whitesmith-job-agent
tart exec "$TARGET" /opt/actions-runner/bin/Runner.Listener --version | while IFS= read -r version; do
  [[ "$version" == "$RUNNER_VERSION" ]] || { print -u2 "unexpected Actions Runner version"; exit 1; }
done

tart stop "$TARGET"
wait "$RUN_PID" >/dev/null 2>&1 || true
RUN_PID=""
SUCCEEDED=1

print -r -- "WHITESMITH_TART_BASE_IMAGE=$TARGET"
print -r -- "WHITESMITH_TART_IMAGE_DIGEST=$LOGICAL_DIGEST"
