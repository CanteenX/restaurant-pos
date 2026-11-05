#!/usr/bin/env bash
umask 022
# Builds <pkg>-<version>-1.<arch>.rpm (x86_64 and aarch64) with rpmbuild; same payload as the deb.
# Usage: packaging/deb/build-rpm.sh <version> [x86_64|aarch64]     Output: dist/ (override with OUT_DIR)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../.." && pwd)
. "$here/product.conf"
command -v rpmbuild >/dev/null || { echo "rpmbuild not found (install the rpm-build package)" >&2; exit 1; }
ver="${1:?version, e.g. 1.2.3}"; ver="${ver#v}"
archs="${2:-x86_64 aarch64}"; out="${OUT_DIR:-$root/dist}"; mkdir -p "$out"
for arch in $archs; do
  stage=$(mktemp -d); top=$(mktemp -d)
  sed "s/@VERSION@/$ver/g" "$here/docker-compose.yml" > "$stage/docker-compose.yml"
  sed "s/@VERSION@/$ver/g" "$here/$PKG.env" > "$stage/$PKG.env.example"
  cp "$here/$PKG.service" "$here/preflight.sh" "$here/postinst" "$here/prerm" "$here/postrm" "$root/LICENSE" "$stage/"
  printf '%s\n' "$LONGDESC" | sed 's/^ \.$//; s/^ //' > "$stage/desc.txt"
  sed -e "s|@PKG@|$PKG|g; s|@VERSION@|$ver|g; s|@RPMARCH@|$arch|g; s|@STAGE@|$stage|g; s|@SHORTDESC@|$SHORTDESC|g; s|@HOMEPAGE@|$HOMEPAGE|g" \
      -e "/@RPMDESC@/{r $stage/desc.txt" -e "d}" "$here/nventra-pos.spec.in" > "$stage/$PKG.spec"
  rpmbuild -bb --target "$arch" --define "_topdir $top" "$stage/$PKG.spec" >/dev/null
  f="$out/${PKG}-${ver}-1.${arch}.rpm"; cp "$top"/RPMS/"$arch"/*.rpm "$f"
  ( cd "$out" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256" )
  rm -rf "$stage" "$top"; echo "$f"
done
