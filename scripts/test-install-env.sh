#!/usr/bin/env bash
# Tests that install.sh never leaves the updater on a public token (#145).
#
# Runs the real install.sh in throwaway directories with stub `docker` and
# `curl` on PATH (nothing is built or started), then checks the .env it
# leaves behind: a new .env gets a random UPDATER_TOKEN, an existing .env
# without one (or with the old published default) gets one, and a token the
# owner set is never touched. With Docker available it also checks that
# `docker compose config` refuses to run without UPDATER_TOKEN.
# Usage: scripts/test-install-env.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# Values compose used to default to: upstream's, then the rebrand's. Both are
# public, so install.sh must replace either.
PUBLIC_DEFAULT="nodedr-restaurant-updater"
REBRAND_DEFAULT="nventra-pos-updater"
pass=0
ok() { echo "ok   $*"; pass=$((pass + 1)); }
fail() { echo "FAIL $*" >&2; exit 1; }

# Stubs: docker answers every prerequisite check and `compose up`; curl makes
# the health wait succeed at once. `openssl` is stubbed only when asked.
mkdir -p "$WORK/bin" "$WORK/bin-noopenssl"
printf '#!/bin/sh\nexit 0\n' >"$WORK/bin/docker"
printf '#!/bin/sh\nexit 0\n' >"$WORK/bin/curl"
cp "$WORK/bin/docker" "$WORK/bin/curl" "$WORK/bin-noopenssl/"
printf '#!/bin/sh\nexit 1\n' >"$WORK/bin-noopenssl/openssl"
chmod +x "$WORK"/bin*/*

run_install() { # run_install <dir> [stubdir]
  cp "$ROOT/install.sh" "$1/install.sh"
  PATH="${2:-$WORK/bin}:$PATH" bash "$1/install.sh" >"$1/out.log" 2>&1 \
    || { cat "$1/out.log" >&2; fail "install.sh exited non-zero in $1"; }
}
token_of() { sed -n 's/^UPDATER_TOKEN=//p' "$1/.env"; }
expect_random_token() { # expect_random_token <dir> <label>
  local t; t="$(token_of "$1")"
  [ "$(grep -c '^UPDATER_TOKEN=' "$1/.env")" = 1 ] || fail "$2: expected exactly one UPDATER_TOKEN line"
  [ "$t" != "$PUBLIC_DEFAULT" ] && [ "$t" != "$REBRAND_DEFAULT" ] || fail "$2: token is a public default"
  [[ "$t" =~ ^[0-9a-f]{64}$ ]] || fail "$2: token '$t' is not 64 random hex chars"
}
case_dir() { mkdir -p "$WORK/$1"; echo "$WORK/$1"; }

# 1. Fresh install: new .env with every secret, token random per install.
a="$(case_dir fresh-a)"; b="$(case_dir fresh-b)"
run_install "$a"; run_install "$b"
expect_random_token "$a" "fresh install"
for k in POSTGRES_PASSWORD JWT_SECRET; do
  grep -qE "^$k=[0-9a-f]{32,}$" "$a/.env" || fail "fresh install: $k missing or not random"
done
[ "$(token_of "$a")" != "$(token_of "$b")" ] || fail "two installs got the same token"
ok "fresh .env gets a random UPDATER_TOKEN (different per install)"

# 2. Existing .env without a token (made before #145): one is appended and
#    every existing line is kept as is. Also without a trailing newline.
d="$(case_dir existing)"
printf 'POSTGRES_PASSWORD=keepme\nJWT_SECRET=keepme-too\nHOST_PORT=1995\n' >"$d/.env"
cp "$d/.env" "$d/before"
run_install "$d"
expect_random_token "$d" "existing .env"
[ "$(head -n 3 "$d/.env")" = "$(cat "$d/before")" ] || fail "existing .env lines changed"
[ "$(wc -l <"$d/.env")" = 4 ] || fail "existing .env: expected exactly one appended line"
grep -q 'UPDATER_TOKEN' "$d/out.log" || fail "install.sh did not say it added UPDATER_TOKEN"
ok "existing .env without UPDATER_TOKEN gets one appended, other lines untouched"

d="$(case_dir no-newline)"
printf 'POSTGRES_PASSWORD=keepme\nHOST_PORT=1995' >"$d/.env"
run_install "$d"
expect_random_token "$d" "no trailing newline"
grep -qx 'HOST_PORT=1995' "$d/.env" || fail "last line was merged with the appended token"
ok "existing .env without a trailing newline: token goes on its own line"

# 3. Re-running is a no-op once a token is there.
cp "$WORK/existing/.env" "$WORK/existing/after-first"
run_install "$WORK/existing"
cmp -s "$WORK/existing/.env" "$WORK/existing/after-first" || fail "second run changed .env"
ok "re-running install.sh leaves the token alone"

# 4. A token the owner set is never replaced; the old public default is.
d="$(case_dir custom)"
printf 'JWT_SECRET=x\nUPDATER_TOKEN=my-own-long-token-value\n' >"$d/.env"
cp "$d/.env" "$d/before"
run_install "$d"
cmp -s "$d/.env" "$d/before" || fail "owner-set UPDATER_TOKEN was changed"
ok "owner-set UPDATER_TOKEN is kept"

for v in "$PUBLIC_DEFAULT" "\"$PUBLIC_DEFAULT\"" "$REBRAND_DEFAULT" "'$REBRAND_DEFAULT'" ""; do
  d="$(case_dir "public-$RANDOM")"
  printf 'JWT_SECRET=x\nUPDATER_TOKEN=%s\nHOST_PORT=1995\n' "$v" >"$d/.env"
  run_install "$d"
  expect_random_token "$d" "UPDATER_TOKEN=$v"
  grep -qx 'JWT_SECRET=x' "$d/.env" && grep -qx 'HOST_PORT=1995' "$d/.env" || fail "other lines changed"
done
ok "UPDATER_TOKEN set to a public default (upstream or rebrand, or empty) is replaced"

# 5. No openssl: the fallback still writes a random token.
d="$(case_dir no-openssl)"
run_install "$d" "$WORK/bin-noopenssl"
expect_random_token "$d" "no openssl"
ok "without openssl the token is still random"

# 6. Compose files: no published default anywhere; root compose requires it.
# (nventra-pos-updater is also the updater's image/container name, so only
# UPDATER_TOKEN lines are checked for it.)
if grep -n "$PUBLIC_DEFAULT" "$ROOT/docker-compose.yml" "$ROOT/casaos/docker-compose.yml" "$ROOT/packaging/deb/docker-compose.yml" \
  || grep -nE "UPDATER_TOKEN.*$REBRAND_DEFAULT" "$ROOT/docker-compose.yml" "$ROOT/casaos/docker-compose.yml" "$ROOT/packaging/deb/docker-compose.yml"; then
  fail "a compose file still ships the public UPDATER_TOKEN"
fi
[ "$(grep -c 'UPDATER_TOKEN: "${UPDATER_TOKEN:?' "$ROOT/docker-compose.yml")" = 2 ] \
  || fail "docker-compose.yml: backend and updater must both use \${UPDATER_TOKEN:?...}"
ok "compose files ship no default token; root compose requires UPDATER_TOKEN"

# CasaOS can't generate secrets, so it ships a placeholder: it must be the same
# in both services and one the updater refuses (in-app updates stay off).
mapfile -t casa < <(sed -n 's/^ *UPDATER_TOKEN: "\(.*\)"$/\1/p' "$ROOT/casaos/docker-compose.yml")
[ "${#casa[@]}" = 2 ] && [ "${casa[0]}" = "${casa[1]}" ] || fail "casaos: backend and updater UPDATER_TOKEN differ"
node -e 'const p=require(process.argv[1]).tokenProblem(process.argv[2]); if(!p) process.exit(1)' \
  "$ROOT/updater/server.js" "${casa[0]}" || fail "casaos placeholder '${casa[0]}' is accepted by the updater"
ok "casaos placeholder is shared by both services and refused by the updater"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  (cd "$WORK" && env -u UPDATER_TOKEN JWT_SECRET=x docker compose -f "$ROOT/docker-compose.yml" \
    --env-file /dev/null config >"$WORK/cfg.log" 2>&1) && fail "compose config ran without UPDATER_TOKEN"
  grep -q 'UPDATER_TOKEN' "$WORK/cfg.log" || fail "compose error does not name UPDATER_TOKEN: $(cat "$WORK/cfg.log")"
  cfg="$(cd "$WORK" && JWT_SECRET=x UPDATER_TOKEN=tok-from-env docker compose -f "$ROOT/docker-compose.yml" \
    --env-file /dev/null config)"
  [ "$(grep -c 'UPDATER_TOKEN: tok-from-env' <<<"$cfg")" = 2 ] || fail "backend and updater do not share the token"
  ok "docker compose config refuses to start without UPDATER_TOKEN"
else
  echo "skip docker compose config checks (no docker compose)"
fi

echo "== install env tests passed ($pass checks)"
