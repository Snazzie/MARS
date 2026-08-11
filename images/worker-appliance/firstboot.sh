#!/usr/bin/env bash
set -euo pipefail
umask 077
JOIN=/media/cidata/whitesmith-join
[[ -r "$JOIN" ]] || { echo 'join seed missing' >&2; exit 1; }
exec 9<"$JOIN"
IFS= read -r BASE_URL <&9
IFS= read -r CODE <&9
unset IFS
[[ "$BASE_URL" == https://* ]] || { echo 'WebPKI HTTPS required' >&2; exit 1; }
install -d -m 700 /var/lib/whitesmith
shred -u "$JOIN" || true
printf '%s\n' "${CODE}" | exec /usr/local/bin/whitesmith-orchestrator join --base-url "$BASE_URL" --code-stdin
