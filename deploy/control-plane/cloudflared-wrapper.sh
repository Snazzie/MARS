#!/bin/sh
set -eu
TOKEN_FILE=${TUNNEL_TOKEN_FILE:-/run/secrets/tunnel_token}
[ -r "$TOKEN_FILE" ] || { echo 'tunnel token file missing' >&2; exit 1; }
IFS= read -r TUNNEL_TOKEN < "$TOKEN_FILE"
export TUNNEL_TOKEN
exec cloudflared tunnel --no-autoupdate run
