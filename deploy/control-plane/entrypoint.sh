#!/bin/sh
set -eu

data_root=${DATA_ROOT:-/var/lib/mars}
mkdir -p "$data_root"
# A bind mount can replace the image directory. Repair only that directory;
# never recurse into operator-managed application data.
chown bun:bun "$data_root"
chmod 700 "$data_root"

exec gosu bun:bun bun run index.js
