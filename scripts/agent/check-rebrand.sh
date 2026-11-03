#!/usr/bin/env bash
# Rebrand guard (#3-#6): package scope, image names and container names must
# be Nventra, and "nodedr" may only appear as upstream attribution (#6).
# Fails (exit 1) listing every offender; passes silently-ish.
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
  cfg=$(JWT_SECRET=check UPDATER_TOKEN=check docker compose -f docker-compose.yml config 2>&1) || bad "docker compose config failed: $cfg"
  odd=$(printf '%s\n' "$cfg" | grep -E '^[[:space:]]+(image|container_name):' | grep -vE 'nventra-pos-|postgres:16' || true)
  [ -n "$odd" ] && bad "docker compose config shows non-nventra names:
$odd"
fi

# 4. "nodedr" only as attribution (#6). Paths in rebrand-allowlist.txt are
#    exempt; on every other line the attribution tokens below are removed
#    first, and whatever still says nodedr is an offender.
ALLOW_FILE=scripts/agent/rebrand-allowlist.txt
specs=()
while IFS= read -r l; do
  l="${l%%#*}"; l="${l%"${l##*[![:space:]]}"}"
  [ -n "$l" ] && specs+=(":(exclude,literal)$l")
done < "$ALLOW_FILE"
ATTRIBUTION='(https?://)?(github\.com|raw\.githubusercontent\.com)/Raktim94/nodedr-[a-z-]+|nodedr-(pos|ecommerce-template)|(fork of|based on|forked from|derived from|upstream) (the )?\[?Nodedr( OrderRestro)?|official Nodedr release|Nodedr Infotech Private Limited|https?://www\.nodedr\.com/?'
left=$(git grep -n -i -I nodedr -- . "${specs[@]}" | while IFS= read -r hit; do
  printf %s "$hit" | sed -E "s#^[^:]+:[0-9]+:##; s#${ATTRIBUTION}##Ig" | grep -qi nodedr && printf '%s\n' "$hit"
done)
[ -n "$left" ] && bad "non-attribution nodedr references (fix them or add the path with a reason to $ALLOW_FILE):
$left"

# 5. The commercial-licence offer is gone and nothing links to it.
[ -e COMMERCIAL-LICENSE.md ] && bad "COMMERCIAL-LICENSE.md still exists"
links=$(git grep -n -i "COMMERCIAL-LICENSE" -- . ':!scripts/agent/check-rebrand.sh' || true)
[ -n "$links" ] && bad "links to COMMERCIAL-LICENSE.md remain:
$links"

# 6. Nventra is the fork, never the upstream: a blind find/replace can turn
#    "fork of Nodedr OrderRestro" into "fork of Nventra POS". TRADEMARK_POLICY.md
#    is exempt: it tells third parties how they may describe a fork of us.
selffork=$(git grep -n -i -I -E "(fork of|forked from) (the )?\\[?Nventra" -- . \
  ':!scripts/agent/check-rebrand.sh' ':!TRADEMARK_POLICY.md' || true)
[ -n "$selffork" ] && bad "self-referential fork claim (upstream is Nodedr OrderRestro):
$selffork"

[ "$fail" = 0 ] && echo "rebrand check: OK"
exit "$fail"
