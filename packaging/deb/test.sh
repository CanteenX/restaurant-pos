#!/usr/bin/env bash
# Installs the .deb on this machine (needs root, systemd and Docker), waits for the app to answer over HTTP,
# then reinstalls, removes and purges it. Usage: sudo DEB=/path/to/pkg.deb packaging/deb/test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); . "$here/product.conf"
step() { printf '\n== %s\n' "$*"; }

# Static checks: need no root, systemd or Docker. Run with: STATIC=1 packaging/deb/test.sh
if [ "${STATIC:-}" = 1 ]; then
  fail() { echo "FAIL: $*" >&2; exit 1; }
  step "product names"
  [ "$PKG" = nventra-pos ] || fail "PKG is '$PKG', expected nventra-pos"
  [ "$PROJECT" = nventra-pos ] || fail "PROJECT is '$PROJECT', expected nventra-pos"
  ! grep -rIli 'nodedr\|orderrestro' "$here" --exclude=test.sh | grep -q . || fail "old names remain: $(grep -rIli 'nodedr\|orderrestro' "$here" --exclude=test.sh | tr '\n' ' ')"
  for f in "$PKG.service" "$PKG.env" build-rpm.sh nventra-pos.spec.in; do [ -f "$here/$f" ] || fail "missing $f"; done
  step "scripts parse"
  for f in build.sh build-rpm.sh install-linux.sh postinst prerm postrm preflight.sh; do [ -f "$here/$f" ] || fail "missing $f"; bash -n "$here/$f" || fail "syntax $f"; done
  step "service unit"
  grep -q "docker compose --project-name $PROJECT" "$here/$PKG.service" || fail "unit does not use project $PROJECT"
  step "installer supports rpm and uninstall"
  grep -q 'dnf' "$here/install-linux.sh" || fail "installer has no dnf/rpm path"
  grep -q -- '--uninstall' "$here/install-linux.sh" || fail "installer has no --uninstall"
  step "deb builds with the new name"
  out=$(mktemp -d); OUT_DIR="$out" RPM=0 bash "$here/build.sh" 0.0.1 amd64 >/dev/null
  [ -f "$out/${PKG}_0.0.1_amd64.deb" ] || fail "deb not built"
  dpkg-deb -I "$out/${PKG}_0.0.1_amd64.deb" | grep -q "Package: $PKG" || fail "deb package name wrong"
  dpkg-deb -c "$out/${PKG}_0.0.1_amd64.deb" | grep -q "lib/systemd/system/$PKG.service" || fail "deb lacks service"
  rm -rf "$out"; echo OK; exit 0
fi

: "${DEB:?set DEB to the .deb path}"
step "install with the one-command installer"; PKG_FILE="$DEB" bash "$here/install-linux.sh"
systemctl is-enabled "$PKG.service"
[ "$(stat -c %a "/etc/$PKG/$PKG.env")" = 600 ] || { echo "env file is not mode 600" >&2; exit 1; }
! grep -q '@SECRET@' "/etc/$PKG/$PKG.env" || { echo "unreplaced secret placeholder" >&2; exit 1; }
step "wait for http://127.0.0.1:$PORT$PATHCHECK"
ok=0; code=000
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$PATHCHECK" || true)
  case "$code" in 2*|3*) ok=1; break;; esac; sleep 5
done
if [ "$ok" != 1 ]; then
  systemctl status "$PKG.service" --no-pager || true; docker ps -a || true
  docker compose --project-name "$PROJECT" logs --tail 60 || true
  echo "app did not answer (last code $code)" >&2; exit 1
fi
echo "answered HTTP $code"
step "reinstall keeps settings"
sum=$(sha256sum "/etc/$PKG/$PKG.env"); apt-get install -y --reinstall "$DEB"
[ "$sum" = "$(sha256sum "/etc/$PKG/$PKG.env")" ] || { echo "settings changed on reinstall" >&2; exit 1; }
step "remove"; apt-get remove -y "$PKG"
! systemctl is-active --quiet "$PKG.service" || { echo "service still active after remove" >&2; exit 1; }
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" ] || { echo "containers still running after remove" >&2; exit 1; }
[ -f "/etc/$PKG/$PKG.env" ] || { echo "settings were removed by apt remove" >&2; exit 1; }
step "purge keeps settings and data"; sum=$(sha256sum "/etc/$PKG/$PKG.env"); apt-get purge -y "$PKG"
[ -f "/etc/$PKG/$PKG.env" ] && [ "$sum" = "$(sha256sum "/etc/$PKG/$PKG.env")" ] || { echo "settings changed or vanished on purge" >&2; exit 1; }
step "reinstall after purge reuses settings and data"
PKG_FILE="$DEB" bash "$here/install-linux.sh"
[ "$sum" = "$(sha256sum "/etc/$PKG/$PKG.env")" ] || { echo "settings regenerated after purge (would not match the data volumes)" >&2; exit 1; }
ok=0; for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$PATHCHECK" || true)
  case "$code" in 2*|3*) ok=1; break;; esac; sleep 5
done
[ "$ok" = 1 ] || { docker compose --project-name "$PROJECT" logs --tail 60 || true; echo "app did not answer after reinstall (last code $code)" >&2; exit 1; }
echo "answered HTTP $code after purge and reinstall"
step "clean up everything"; apt-get purge -y "$PKG"; docker compose --project-name "$PROJECT" down -v >/dev/null 2>&1 || true; rm -rf "/etc/$PKG"
echo OK
