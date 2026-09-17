#!/bin/bash
# Launch Nanobot Mission Control production server on port 3000.
# Resolves the repo from this script's location so the same file works on
# mint-nanobot (/srv/nanobot/mission-control/source) and local checkouts.

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"
export NODE_ENV="production"

if [ -z "${HOME:-}" ]; then
  export HOME="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)"
fi

cd "$(cd "$(dirname "$0")" && pwd)"

# Load env vars (.env.local is not auto-loaded by next start in production)
if [ -f .env.local ]; then
  set -a
  . .env.local
  set +a
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

exec "$NODE_BIN" node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3000
