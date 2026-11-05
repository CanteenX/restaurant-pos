#!/usr/bin/env bash
# Update + rollback drill for the in-app updater (updater/server.js).
#
# Runs the REAL updater container against a throwaway "install" of two app
# containers (stand-in images from scripts/update-drill/, published to a local
# registry, so the updater pulls exactly like it pulls from GHCR):
#   N      = 1.0.0  (running, with data written to its volume)
#   N+1    = 1.0.1  healthy      -> must end up running, data intact
#   broken = 1.0.2  web fails its health check
#                    -> both containers must be back on 1.0.1 automatically,
#                       data intact, status `rolled_back` with the reason
# Exits non-zero on the first failed assertion. Touches only drill-* containers,
# the drill volume/network and a registry on 127.0.0.1:${DRILL_REGISTRY_PORT}.
#
# Usage: scripts/update-rollback-drill.sh
#   UPDATER_SRC=dir   build the updater from another directory (default updater/)
#   KEEP=1            leave the drill containers running afterwards
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

UPDATER_SRC="${UPDATER_SRC:-updater}"
REG_PORT="${DRILL_REGISTRY_PORT:-5055}"
REG="127.0.0.1:${REG_PORT}"
NET=nventra-drill-net
VOL=nventra-drill-data
TOKEN="drill-$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
UPDATER_PORT=18080
APP_PORT=18081

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nDRILL FAILED: %s\n' "$*" >&2; docker logs drill-updater 2>&1 | tail -20 >&2 || true; exit 1; }

cleanup() {
  [ "${KEEP:-0}" = "1" ] && return
  docker rm -f drill-updater drill-backend drill-web drill-backend-old drill-web-old drill-registry >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -f scripts/agent/gh-rest.sh ] && ! docker info >/dev/null 2>&1; then
  # shellcheck source=scripts/agent/gh-rest.sh
  source scripts/agent/gh-rest.sh && ensure_docker
fi

say "updater unit tests"
node --test updater/server.test.js >/dev/null 2>&1 || fail "node --test updater/server.test.js"

cleanup
say "local registry + stand-in images"
docker run -d --name drill-registry -p "$REG:5000" registry:2.8.3 >/dev/null
for _ in $(seq 1 30); do curl -fsS "http://$REG/v2/" >/dev/null 2>&1 && break; sleep 1; done
build() { # repo version broken
  docker build -q -t "$REG/canteenx/$1:$2" --build-arg "APP_VERSION=$2" --build-arg "BROKEN=$3" scripts/update-drill >/dev/null
  docker push -q "$REG/canteenx/$1:$2" >/dev/null
}
for app in nventra-pos-backend nventra-pos-web; do
  build "$app" 1.0.0 0
  build "$app" 1.0.1 0
done
build nventra-pos-backend 1.0.2 0
build nventra-pos-web 1.0.2 1
# Force the updater to really pull N+1 rather than find it cached.
docker image rm "$REG/canteenx/nventra-pos-backend:1.0.1" "$REG/canteenx/nventra-pos-web:1.0.1" \
  "$REG/canteenx/nventra-pos-backend:1.0.2" "$REG/canteenx/nventra-pos-web:1.0.2" >/dev/null

say "install N = 1.0.0"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
# Health checks live on the container (as in docker-compose.yml) and are
# carried over to the replacement container by the updater.
HC=(--health-cmd "wget -q -O /dev/null http://127.0.0.1:4000/health || exit 1"
    --health-interval 1s --health-timeout 2s --health-retries 3 --health-start-period 2s)
docker run -d --name drill-backend --network "$NET" --restart unless-stopped \
  -v "$VOL:/data" -p "127.0.0.1:$APP_PORT:4000" "${HC[@]}" "$REG/canteenx/nventra-pos-backend:1.0.0" >/dev/null
docker run -d --name drill-web --network "$NET" --restart unless-stopped \
  "${HC[@]}" "$REG/canteenx/nventra-pos-web:1.0.0" >/dev/null

docker build -q -t nventra-drill-updater "$UPDATER_SRC" >/dev/null
docker run -d --name drill-updater --network "$NET" -p "127.0.0.1:$UPDATER_PORT:8080" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e UPDATER_TOKEN="$TOKEN" -e TARGET_CONTAINERS=drill-backend,drill-web \
  -e HEALTH_TIMEOUT_MS=60000 -e HEALTH_GRACE_MS=3000 nventra-drill-updater >/dev/null

app() { curl -fsS --retry 30 --retry-delay 1 --retry-all-errors "http://127.0.0.1:$APP_PORT$1" "${@:2}"; }
upd() { curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$UPDATER_PORT$1" "${@:2}"; }
image_of() { docker inspect -f '{{.Config.Image}}' "$1"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];console.log(v??"")})' "$1"; }

for _ in $(seq 1 30); do upd /v1/status >/dev/null 2>&1 && break; sleep 1; done
app /notes -X POST -d "order #1 before update" >/dev/null
[ "$(app /version | field version)" = 1.0.0 ] || fail "N is not running 1.0.0"

update_to() { # version -> prints the final updater status JSON
  local code
  code=$(upd /v1/update -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"version\":\"$1\"}")
  [ "$code" = 202 ] || fail "updater refused $1 (HTTP $code)"
  local s
  for _ in $(seq 1 120); do
    s=$(upd /v1/status)
    case "$(printf '%s' "$s" | field state)" in pulling|restarting) sleep 1 ;; *) printf '%s' "$s"; return ;; esac
  done
  fail "update to $1 did not finish in 120s: $s"
}

say "success path: 1.0.0 -> 1.0.1"
s=$(update_to 1.0.1); echo "$s"
[ "$(printf '%s' "$s" | field state)" = done ] || fail "expected state done"
[ "$(image_of drill-backend)" = "$REG/canteenx/nventra-pos-backend:1.0.1" ] || fail "backend not on 1.0.1"
[ "$(image_of drill-web)" = "$REG/canteenx/nventra-pos-web:1.0.1" ] || fail "web not on 1.0.1"
[ "$(app /version | field version)" = 1.0.1 ] || fail "app does not report 1.0.1"
app /notes | grep -q "order #1 before update" || fail "data lost on upgrade"
app /notes -X POST -d "order #2 on 1.0.1" >/dev/null
echo "ok: 1.0.1 running, data intact"

say "failure path: 1.0.1 -> broken 1.0.2 (web unhealthy)"
s=$(update_to 1.0.2); echo "$s"
[ "$(printf '%s' "$s" | field state)" = rolled_back ] || fail "expected state rolled_back (no automatic rollback)"
[ "$(printf '%s' "$s" | field rolledBackTo)" = 1.0.1 ] || fail "expected rolledBackTo 1.0.1"
printf '%s' "$s" | field error | grep -q "drill-web" || fail "rollback reason does not name the failing container"
[ "$(image_of drill-backend)" = "$REG/canteenx/nventra-pos-backend:1.0.1" ] || fail "backend not restored to 1.0.1"
[ "$(image_of drill-web)" = "$REG/canteenx/nventra-pos-web:1.0.1" ] || fail "web not restored to 1.0.1"
for c in drill-backend drill-web; do
  for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' $c)" = healthy ] && break; sleep 1; done
  [ "$(docker inspect -f '{{.State.Health.Status}}' $c)" = healthy ] || fail "$c not healthy after rollback"
done
docker inspect drill-backend-old drill-web-old >/dev/null 2>&1 && fail "leftover -old containers"
[ "$(app /version | field version)" = 1.0.1 ] || fail "app does not report 1.0.1 after rollback"
notes=$(app /notes)
echo "$notes" | grep -q "order #1 before update" && echo "$notes" | grep -q "order #2 on 1.0.1" || fail "data lost on rollback"
echo "ok: rolled back to 1.0.1 automatically, data intact"

say "DRILL PASSED"
