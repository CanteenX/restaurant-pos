#!/usr/bin/env bash
# Upgrade drill for installs made before the Nventra rename (#143).
#
#   1. Old install: postgres:16-alpine with the OLD identity (POSTGRES_USER=nodedr,
#      POSTGRES_DB=nodedr_restaurant) on a fresh volume, migrated and seeded
#      with demo data through the old DATABASE_URL.
#   2. Upgrade: recreate the Postgres container with the NEW compose settings
#      (nventra / nventra_pos) on the SAME volume, then start the backend with
#      the new DATABASE_URL using the exact CMD from apps/backend/Dockerfile.
#   3. Check: the compose healthcheck passes before and after, the backend is
#      healthy, demo data is still there (row counts + owner login), and a
#      second start is a no-op.
#
# Backend runs from source (cloud VMs cannot build the images); Postgres runs
# in Docker. Uses its own container, volume and ports; removes them on exit.
# Usage: scripts/test-db-identity-upgrade.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
N=nventra-upgrade-drill
PG_PORT="${DRILL_PG_PORT:-55432}"
API_PORT="${DRILL_API_PORT:-4021}"
LOG="${TMPDIR:-/tmp}/$N"; mkdir -p "$LOG"
PW="$(openssl rand -hex 16)"
BACKEND_PID=""

# shellcheck source=scripts/agent/gh-rest.sh
source scripts/agent/gh-rest.sh   # ensure_docker
ensure_docker

stop_backend() {
  [ -n "$BACKEND_PID" ] || return 0
  kill -TERM -- "-$BACKEND_PID" 2>/dev/null || kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  BACKEND_PID=""
}
cleanup() {
  stop_backend
  docker rm -f "$N" >/dev/null 2>&1 || true
  docker volume rm "$N-pg" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $*"; }

# Values the shipped files use, read from them so the drill tracks changes.
HEALTHCHECK="$(grep -o 'pg_isready -U [a-z_]* -d [a-z_]*' docker-compose.yml)"
CMD="$(sed -n 's/^CMD \["sh", "-c", "\(.*\)"\]$/\1/p' apps/backend/Dockerfile)"
grep -q 'POSTGRES_USER: nventra' docker-compose.yml || fail "docker-compose.yml no longer uses nventra"
[ -n "$CMD" ] || fail "could not read CMD from apps/backend/Dockerfile"

start_pg() { # start_pg <user> <db>
  docker rm -f "$N" >/dev/null 2>&1 || true
  docker run -d --name "$N" -e POSTGRES_USER="$1" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB="$2" \
    -v "$N-pg:/var/lib/postgresql/data" -p "127.0.0.1:$PG_PORT:5432" postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$N" pg_isready -h 127.0.0.1 -U "$1" >/dev/null 2>&1 \
      && (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null && return 0
    sleep 1
  done
  fail "postgres did not start"
}
counts() { # counts <user> <db>  -> "users=N orders=N menu_items=N"
  docker exec -e PGPASSWORD="$PW" "$N" psql -h 127.0.0.1 -U "$1" -d "$2" -tAc \
    "SELECT 'users='||(SELECT count(*) FROM users)||' orders='||(SELECT count(*) FROM orders)||' menu_items='||(SELECT count(*) FROM menu_items)"
}
healthcheck() { docker exec "$N" sh -c "$HEALTHCHECK -h 127.0.0.1" >/dev/null; }

export JWT_SECRET="drill-only-not-a-secret-drill-only-not-a-secret"
export PORT="$API_PORT" CORS_ORIGIN="http://localhost:1995" COOKIE_SECURE=false
OLD_URL="postgresql://nodedr:$PW@localhost:$PG_PORT/nodedr_restaurant"
NEW_URL="postgresql://nventra:$PW@localhost:$PG_PORT/nventra_pos"

step "build backend"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile >"$LOG/install.log" 2>&1
pnpm --filter ./packages/types build >"$LOG/types.log" 2>&1
pnpm --filter ./apps/backend exec prisma generate >"$LOG/generate.log" 2>&1
pnpm --filter ./apps/backend build >"$LOG/build.log" 2>&1

step "1. old install (nodedr / nodedr_restaurant) with demo data"
docker volume rm "$N-pg" >/dev/null 2>&1 || true
start_pg nodedr nodedr_restaurant
( cd apps/backend && DATABASE_URL="$OLD_URL" pnpm exec prisma migrate deploy \
  && DATABASE_URL="$OLD_URL" pnpm exec ts-node prisma/seed.ts ) >"$LOG/old.log" 2>&1 \
  || { tail -20 "$LOG/old.log" >&2; fail "could not migrate/seed the old install"; }
BEFORE="$(counts nodedr nodedr_restaurant)"
echo "   data: $BEFORE"

step "2. upgrade: Postgres recreated with the new compose settings, same volume"
start_pg nventra nventra_pos
healthcheck || fail "compose healthcheck ($HEALTHCHECK) fails on the old volume"
echo "   compose healthcheck passes on the old volume"
docker exec -e PGPASSWORD="$PW" "$N" psql -h 127.0.0.1 -U nventra -d nventra_pos -c 'SELECT 1' >/dev/null 2>&1 \
  && fail "nventra can already log in; the drill is not testing an old volume"
echo "   before the backend starts, nventra cannot log in (the reported failure)"

start_backend() { # start_backend <logfile>
  ! curl -s -o /dev/null "http://localhost:$API_PORT/" 2>/dev/null || fail "port $API_PORT is already in use"
  # Own process group, so stop_backend also stops node (a child of sh -c).
  ( cd apps/backend && DATABASE_URL="$NEW_URL" exec setsid sh -c "$CMD" ) >"$1" 2>&1 &
  BACKEND_PID=$!
  for _ in $(seq 1 90); do
    curl -sf "http://localhost:$API_PORT/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$BACKEND_PID" 2>/dev/null || break
    sleep 1
  done
  tail -30 "$1" >&2; fail "backend did not become healthy"
}
start_backend "$LOG/backend-1.log"
grep -q 'renamed Postgres role nodedr -> nventra' "$LOG/backend-1.log" || fail "upgrade step did not run"
echo "   backend healthy: $(grep -o 'renamed Postgres role[^[:cntrl:]]*' "$LOG/backend-1.log" | head -1)"

step "3. data and login survive"
AFTER="$(counts nventra nventra_pos)"
[ "$AFTER" = "$BEFORE" ] || fail "data changed: before '$BEFORE' after '$AFTER'"
echo "   data: $AFTER"
healthcheck || fail "compose healthcheck fails after the upgrade"
echo "   compose healthcheck passes after the upgrade"
code="$(curl -s -o "$LOG/login.json" -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.local","password":"Password123!"}' "http://localhost:$API_PORT/api/v1/auth/login")"
case "$code" in 200|201) ;; *) fail "demo owner login returned $code: $(cat "$LOG/login.json")" ;; esac
echo "   owner@demo.local signs in (HTTP $code)"
left="$(docker exec -e PGPASSWORD="$PW" "$N" psql -h 127.0.0.1 -U nventra -d postgres -tAc \
  "SELECT string_agg(rolname, ',') FROM pg_roles WHERE rolname IN ('nodedr','nventra_identity_upgrade')
   UNION ALL SELECT string_agg(datname, ',') FROM pg_database WHERE datname = 'nodedr_restaurant'" | tr -d '\n')"
[ -z "$left" ] || fail "legacy role/database or helper role left behind: $left"

step "4. restart is a no-op"
stop_backend
docker restart "$N" >/dev/null
for _ in $(seq 1 30); do healthcheck && break; sleep 1; done
start_backend "$LOG/backend-2.log"
grep -q 'database identity is current' "$LOG/backend-2.log" || fail "second start was not a no-op"
[ "$(counts nventra nventra_pos)" = "$BEFORE" ] || fail "data changed on restart"
echo "   second start: database identity is current"

echo "== upgrade drill passed (logs: $LOG)"
