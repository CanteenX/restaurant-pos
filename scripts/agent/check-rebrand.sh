#!/usr/bin/env bash
# Rebrand 1/4 guard (#3): package scope, image names and container names must
# be Nventra. Fails (exit 1) listing every offender; passes silently-ish.
#   scripts/agent/check-rebrand.sh
# Uses `docker compose config` for the root compose file when Docker is
# available, and a plain grep of every compose file otherwise.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
bad() { echo "FAIL: $*"; fail=1; }

# 1. No old workspace scope anywhere in tracked files (lockfile included).
hits=$(git grep -n "@nodedr-restaurant" -- . ':!scripts/agent/check-rebrand.sh' || true)
[ -n "$hits" ] && bad "old package scope @nodedr-restaurant still referenced:
$hits"

# 2. Workspace package names.
for f in apps/backend/package.json packages/types/package.json; do
  name=$(node -p "require('./$f').name")
  case "$name" in @nventra/*) ;; *) bad "$f name is '$name' (want @nventra/*)";; esac
done
root=$(node -p "require('./package.json').name")
[ "$root" = "nventra-pos" ] || bad "package.json name is '$root' (want nventra-pos)"

# 3. Compose image and container names.
COMPOSE_FILES="docker-compose.yml casaos/docker-compose.yml packaging/deb/docker-compose.yml mobile/demo/docker-compose.yml"
for f in $COMPOSE_FILES; do
  while IFS= read -r line; do
    val=$(printf %s "$line" | sed -E 's/^[^:]+:[[:space:]]*//; s/["'\'']//g')
    case "$line" in
      *image:*)
        case "$val" in
          postgres:*|ghcr.io/canteenx/nventra-pos-backend:*|ghcr.io/canteenx/nventra-pos-web:*|ghcr.io/canteenx/nventra-pos-updater:*) ;;
          *) bad "$f image '$val' (want ghcr.io/canteenx/nventra-pos-*)";;
        esac ;;
      *container_name:*|*hostname:*)
        case "$val" in nventra-pos-*|orderrestro-demo-*) ;; *) bad "$f ${line%%:*} '$val' (want nventra-pos-*)";; esac ;;
    esac
  done < <(grep -E '^[[:space:]]+(image|container_name|hostname):' "$f")
done

if docker info >/dev/null 2>&1; then
  cfg=$(JWT_SECRET=check docker compose -f docker-compose.yml config 2>&1) || bad "docker compose config failed: $cfg"
  odd=$(printf '%s\n' "$cfg" | grep -E '^[[:space:]]+(image|container_name):' | grep -vE 'nventra-pos-|postgres:16' || true)
  [ -n "$odd" ] && bad "docker compose config shows non-nventra names:
$odd"
fi

[ "$fail" = 0 ] && echo "rebrand check: OK"
exit "$fail"
