#!/bin/sh
# Hosted volumes (Railway, Fly, some VPS setups) are mounted root-owned. Fix ownership of
# the data dir as root, then drop to the unprivileged `node` user for the bot itself.
set -e
DATA_DIR="$(dirname "${DB_PATH:-/app/data/scanner.db}")"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
