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
  case "${DATABASE_URL:-}" in
    postgresql://nventra:*@postgres:5432/nventra_pos*|postgresql://nventra:*@nventra-pos-postgres:5432/nventra_pos*|\
    postgresql://nodedr:*@postgres:5432/nodedr_restaurant*|postgresql://nodedr:*@nventra-pos-postgres:5432/nodedr_restaurant*)
      echo 'Stock database configuration detected. Apply the current Compose or CasaOS definition before starting this image.' >&2
      exit 1
      ;;
  esac
  if [ "${1:-}" = serve ]; then
    node dist/src/system/db-identity-upgrade.cli.js
    node node_modules/prisma/build/index.js migrate deploy
  fi
fi

if [ "${1:-}" = serve ]; then
  exec node dist/src/main.js
fi
exec "$@"
