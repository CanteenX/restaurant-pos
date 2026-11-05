#!/usr/bin/env bash
# Two-install convergence check for multi-branch sync (#83).
#
# Runs apps/backend/test/sync-convergence.e2e-spec.ts twice. The suite starts
# HQ and a branch as two full backends on their own Postgres databases
# (created, migrated and dropped by the suite), edits on both sides while
# offline, reconnects and asserts identical rows on both:
#   1. with sync disabled: the suite MUST fail (proves it detects divergence);
#   2. with sync enabled: it must pass (create/create, update/update,
#      delete/update, store-credit balances, network drop mid-batch).
#
# Uses $DATABASE_URL (any database on a Postgres 16 server the user may
# create databases on); without it, starts a throwaway postgres:16-alpine
# container and removes it on exit.
# Usage: scripts/sync-convergence.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
LOG="${TMPDIR:-/tmp}/sync-convergence"; mkdir -p "$LOG"
PG=nventra-convergence-pg

if [ -z "${DATABASE_URL:-}" ]; then
  # shellcheck source=scripts/agent/gh-rest.sh
  source scripts/agent/gh-rest.sh   # ensure_docker
  ensure_docker
  port="${CONVERGENCE_PG_PORT:-55433}"
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" -e POSTGRES_USER=conv -e POSTGRES_PASSWORD=conv -e POSTGRES_DB=conv \
    -p "127.0.0.1:$port:5432" postgres:16-alpine >/dev/null
  trap 'docker rm -f "$PG" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U conv >/dev/null 2>&1 && break; sleep 1; done
  export DATABASE_URL="postgresql://conv:conv@127.0.0.1:$port/conv"
fi
export JWT_SECRET="${JWT_SECRET:-convergence-only-not-a-secret-0000000000}"
export SYNC_CONVERGENCE_E2E=1

echo "== build"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile >"$LOG/install.log" 2>&1
pnpm --filter ./packages/types build >"$LOG/types.log" 2>&1
pnpm --filter ./apps/backend exec prisma generate >"$LOG/generate.log" 2>&1

suite() {
  (cd apps/backend && npx jest --config ./test/jest-e2e.json sync-convergence --testTimeout=60000)
}

echo "== 1. sync disabled: the suite must fail"
if SYNC_CONVERGENCE_DISABLE=1 suite >"$LOG/disabled.log" 2>&1; then
  echo "FAIL: the suite passed without sync, so it cannot detect divergence" >&2
  exit 1
fi
grep -E "^Tests:" "$LOG/disabled.log" | sed 's/^/   /'

echo "== 2. sync enabled: the suite must pass"
if ! suite >"$LOG/enabled.log" 2>&1; then
  tail -60 "$LOG/enabled.log" >&2
  echo "FAIL: the installs did not converge (log: $LOG/enabled.log)" >&2
  exit 1
fi
grep -E "^Tests:" "$LOG/enabled.log" | sed 's/^/   /'
echo "== convergence check passed (logs: $LOG)"
