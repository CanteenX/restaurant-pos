#!/usr/bin/env bash
# One-click installer for Nventra POS (a fork of Nodedr OrderRestro).
#
# Run this from the repo root after cloning:
#   ./install.sh
#
# Generates a .env with random secrets (only if one doesn't already exist),
# builds the backend + web Docker images, starts the stack, and waits for the
# backend to come up (migrations run automatically on container start). Safe
# to re-run any time (after `git pull`, to rebuild) — nothing here overwrites
# an existing .env or destroys existing data.
#
# Pass --demo to also load seed data (a sample restaurant, menu, and a
# owner@demo.local login) for trying the app out. Without it, sign up your
# own restaurant at /signup — no demo data is created.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

load_demo=false
for arg in "$@"; do
  case "$arg" in
    --demo) load_demo=true ;;
  esac
done

# --- 1. Check prerequisites -------------------------------------------------
# Docker Engine must be installed and the `docker compose` plugin available
# (it ships by default with current Docker Desktop / Docker Engine). See
# "Installing Docker" in README.md for per-OS one-liners if this fails.
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is not installed." >&2
  echo "See 'Installing Docker' in README.md, or https://docs.docker.com/get-docker/ — then re-run this script." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: the 'docker compose' plugin was not found." >&2
  echo "Update Docker Desktop/Engine to a version that bundles Compose v2." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is installed but not running, or your user can't talk to it." >&2
  echo "Start Docker, and on Linux add your user to the 'docker' group (or re-run with sudo)." >&2
  exit 1
fi

# The readiness check below uses curl.
if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required (used to wait for the app to come online). Install it and re-run." >&2
  exit 1
fi

# --- 2. Generate .env if one doesn't exist already --------------------------
# A one-click install can't ask you to hand-edit JWT_SECRET/POSTGRES_PASSWORD
# first (docker-compose.yml has no insecure default for either — it fails
# loudly instead), so generate real random values here. Never overwrites an
# existing .env, so re-running this script is safe.
rand_hex() { # rand_hex <bytes> -> 2*bytes random hex characters
  openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

if [ ! -f .env ]; then
  echo "No .env found — generating one with random secrets..."
  cat > .env <<EOF
POSTGRES_PASSWORD=$(rand_hex 16)
JWT_SECRET=$(rand_hex 32)
UPDATER_TOKEN=$(rand_hex 32)
FRONTEND_ORIGIN=http://localhost:1995
HOST_PORT=1995
COOKIE_SECURE=false
EOF
  echo ".env created with a generated POSTGRES_PASSWORD, JWT_SECRET and UPDATER_TOKEN."
fi

# The updater container holds the Docker socket, and UPDATER_TOKEN is all that
# stands between it and every other container on the network. A .env from
# before this was generated has none (compose then refuses to start) or the
# value compose used to default to, which is public: give it a random one.
# A token you set yourself is left alone.
current_token="$(sed -n 's/^UPDATER_TOKEN=//p' .env | tail -n 1 | tr -d "\"'\r")"
if [ -z "$current_token" ] || [ "$current_token" = "nodedr-restaurant-updater" ]; then
  tmp_env="$(mktemp .env.XXXXXX)"
  grep -v '^UPDATER_TOKEN=' .env > "$tmp_env" || true
  # If the file had no trailing newline, keep its last line intact.
  if [ -s "$tmp_env" ] && [ -n "$(tail -c 1 "$tmp_env")" ]; then echo >> "$tmp_env"; fi
  echo "UPDATER_TOKEN=$(rand_hex 32)" >> "$tmp_env"
  cat "$tmp_env" > .env
  rm -f "$tmp_env"
  echo "Added a random UPDATER_TOKEN to .env (used only between the app and its updater container)."
fi

# --- 3. Build the images and start the stack --------------------------------
echo "Building Nventra POS images and starting the stack (this can take a few minutes on first run)..."
docker compose up -d --build

# --- 4. Wait for the app to report healthy ----------------------------------
# The backend container's own start command runs `prisma migrate deploy`
# before it starts listening, so a 200 here means migrations already applied.
HOST_PORT="$(grep -m1 '^HOST_PORT=' .env 2>/dev/null | cut -d= -f2- || true)"
HOST_PORT="${HOST_PORT:-1995}"

echo "Waiting for the app to come online..."
ready=false
for _ in $(seq 1 90); do
  if curl -sf "http://localhost:${HOST_PORT}/api/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" != "true" ]; then
  echo "Warning: the app didn't respond within 90s. Check the logs with:" >&2
  echo "  docker compose logs" >&2
  exit 1
fi

# --- 5. Load demo data (only if --demo was passed) --------------------------
# seed.ts is upsert-based throughout, so this is safe to run on every install/
# re-install without duplicating or clobbering anything.
if [ "$load_demo" = true ]; then
  echo "Loading demo data (restaurant, menu, staff logins)..."
  docker exec nventra-pos-backend npx ts-node prisma/seed.ts
fi

# --- 6. Done -----------------------------------------------------------------
echo ""
echo "Nventra POS is up and running."
echo "Open http://localhost:${HOST_PORT}"
if [ "$load_demo" = true ]; then
  echo "Sign in with the demo account: owner@demo.local / Password123!"
  echo "(demo account — change the password or remove it before real use)"
else
  echo "Create your restaurant account at http://localhost:${HOST_PORT}/signup"
fi
