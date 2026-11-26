#!/bin/sh
set -eu

if [ "${1:-}" = setup ]; then
  exec node dist/src/system/db-runtime.cli.js setup
fi

if [ -n "${NVENTRA_DATABASE_URL_FILE:-}" ]; then
  unset DATABASE_BOOTSTRAP_URL POSTGRES_PASSWORD
  DATABASE_URL="$(cat "$NVENTRA_DATABASE_URL_FILE")"
  export DATABASE_URL
  node dist/src/system/db-runtime.cli.js check
else
  if [ "${1:-}" = serve ]; then
    node dist/src/system/db-identity-upgrade.cli.js
    node node_modules/prisma/build/index.js migrate deploy
  elif [ -n "${DATABASE_URL:-}" ]; then
    node dist/src/system/db-identity-upgrade.cli.js --check-stock-config
  fi
fi

if [ "${1:-}" = serve ]; then
  exec node dist/src/main.js
fi
exec "$@"
