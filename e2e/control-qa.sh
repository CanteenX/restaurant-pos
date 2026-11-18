#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node --test e2e/control-seed.test.cjs
docker info --format '{{.ServerVersion}}' >/dev/null
work="$(mktemp -d)"
pg=''
api=''
web=''
cleanup() {
  for pid in "$web" "$api"; do
    [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  done
  [ -z "$pg" ] || docker rm -f "$pg" >/dev/null 2>&1 || true
  rm -f "$work/control-api.log" "$work/control-web.log"
  rmdir "$work"
}
trap cleanup EXIT
if ! command -v pnpm >/dev/null; then
  pnpm() { npx --yes --package=pnpm@11.10.0 -- pnpm "$@"; }
fi
node -e '
  const { createServer } = require("node:net");
  for (const port of [4172, 4173]) {
    createServer().on("error", () => { process.exitCode = 1 })
      .listen(port).on("listening", function () { this.close(); });
  }
'
pnpm --filter @nventra/control... --filter @nventra/control-api... install --frozen-lockfile
pnpm --filter @nventra/types build
pnpm --filter @nventra/control-api build
npm --prefix e2e ci --ignore-scripts --no-audit --no-fund
if [ "${CONTROL_QA_INSTALL_CHROMIUM:-}" = 1 ]; then
  node e2e/node_modules/@playwright/test/cli.js install --with-deps --only-shell chromium
fi
pg="$(docker run -d -e POSTGRES_USER=fixture -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=fixture -p 127.0.0.1::5432 postgres:16-alpine)"
pg_ready() {
  docker exec "$pg" pg_isready -h 127.0.0.1 -U fixture >/dev/null 2>&1
}
for _ in {1..30}; do
  pg_ready && break
  sleep 1
done
pg_ready || { echo 'Control fixture database did not become ready.' >&2; exit 1; }
binding="$(docker port "$pg" 5432/tcp)"
export CONTROL_DATABASE_URL="postgresql://fixture:fixture@$binding/fixture"
export CONTROL_AUTH_KEY='a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5'
export CONTROL_ORIGIN='https://localhost:4172' CONTROL_API_PORT=4173
export CONTROL_API_ORIGIN='http://127.0.0.1:4173' NEXT_TELEMETRY_DISABLED=1
docker exec "$pg" psql -U fixture -d fixture -v ON_ERROR_STOP=1 -c 'CREATE ROLE control_runtime NOLOGIN' >/dev/null
pnpm --filter @nventra/control-api exec prisma migrate deploy
node e2e/control/seed.cjs "${binding#127.0.0.1:}"
export CONTROL_DATABASE_URL="${CONTROL_DATABASE_URL}?options=-c%20role%3Dcontrol_runtime"
node -e 'void require("./apps/control-api/dist/bootstrap.js").createControlApi(process.env).then(({app,port}) => app.listen(port,"127.0.0.1"))' >"$work/control-api.log" 2>&1 & api=$!
node apps/control/node_modules/next/dist/bin/next dev apps/control -H localhost -p 4172 >"$work/control-web.log" 2>&1 & web=$!
ready() {
  curl -fsS --max-time 3 'http://127.0.0.1:4173/api/control/v1/health' >/dev/null 2>&1 &&
    curl -sS --max-time 3 'http://localhost:4172/' >/dev/null 2>&1
}
for _ in {1..60}; do
  ready && break
  sleep 1
done
ready || { echo 'Control fixture failed to start.' >&2; exit 1; }
node e2e/node_modules/@playwright/test/cli.js test -c e2e/playwright.control.config.ts "$@"