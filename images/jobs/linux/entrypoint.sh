#!/usr/bin/env sh
set -eu
exec /usr/local/bin/whitesmith-job-agent guest-service \
  --platform linux-x64 \
  --completion-mode exit \
  --bootstrap-file /var/lib/whitesmith/bootstrap/bootstrap.json \
  --runner-root /opt/actions-runner
