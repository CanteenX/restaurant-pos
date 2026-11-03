#!/usr/bin/env bash
# Browser QA WITHOUT building the Docker images: Postgres runs in Docker, the
# backend and web app run from source. Used in Claude cloud VMs, whose network
# blocks the GitHub-release download in apps/backend/Dockerfile.
# Fresh demo data every run (owner@demo.local / Password123!) on :1995.
# Usage: scripts/agent/qa-native.sh [playwright args]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
LOG="${TMPDIR:-/tmp}/qa-native"; mkdir -p "$LOG"

# shellcheck source=scripts/agent/gh-rest.sh
source scripts/agent/gh-rest.sh
ensure_docker

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  docker rm -f qa-pg >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== postgres"
docker rm -f qa-pg >/dev/null 2>&1 || true
docker run -d --name qa-pg -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=qa -e POSTGRES_DB=qa \
  -p 5432:5432 postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec qa-pg pg_isready -U qa >/dev/null 2>&1 && break; sleep 1; done

export DATABASE_URL="postgresql://qa:qa@localhost:5432/qa"
export JWT_SECRET="qa-only-not-a-secret-qa-only-not-a-secret"
export PORT=4001 CORS_ORIGIN="http://localhost:1995" FRONTEND_ORIGIN="http://localhost:1995" COOKIE_SECURE=false
export BACKEND_URL="http://localhost:4001" NEXT_TELEMETRY_DISABLED=1

echo "== install + build (types, prisma, backend, web)"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile >"$LOG/install.log" 2>&1
pnpm --filter ./packages/types build >"$LOG/types.log" 2>&1
( cd apps/backend && pnpm exec prisma generate && pnpm exec prisma migrate deploy && pnpm exec ts-node prisma/seed.ts ) >"$LOG/db.log" 2>&1
pnpm --filter ./apps/backend build >"$LOG/backend-build.log" 2>&1
pnpm --filter ./apps/web build >"$LOG/web-build.log" 2>&1

echo "== start backend :4001 and web :1995"
( cd apps/backend && node dist/src/main.js >"$LOG/backend.log" 2>&1 ) & PIDS+=($!)
( cd apps/web && pnpm exec next start -p 1995 >"$LOG/web.log" 2>&1 ) & PIDS+=($!)
for _ in $(seq 1 90); do curl -sf http://localhost:1995/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://localhost:1995/api/health >/dev/null || { echo "app did not come up; see $LOG" >&2; tail -30 "$LOG/backend.log" "$LOG/web.log" >&2; exit 1; }

echo "== Playwright"
cd "$ROOT/e2e"
npm install --no-audit --no-fund --silent
CI=1 npx playwright test "$@"
echo "== QA passed (logs: $LOG)"
