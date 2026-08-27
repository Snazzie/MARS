#!/usr/bin/env sh
set -eu
exec /usr/local/bin/mars-job-agent guest-service \
  --platform linux-x64 \
  --completion-mode exit \
  --bootstrap-file /var/lib/mars/bootstrap/bootstrap.json \
  --runner-root /opt/actions-runner
