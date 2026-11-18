#!/usr/bin/env bash
# Browser QA for agents: fresh demo stack -> Playwright e2e -> teardown.
# Runs inside the Claude cloud VM (Docker + Chrome for Testing available), so
# it costs no GitHub Actions minutes. Usage: scripts/agent/qa.sh [playwright args]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Claude cloud VMs cannot build the Docker images (their network blocks the
# GitHub-release download in apps/backend/Dockerfile), so run the stack from
# source there instead. QA_MODE=docker forces the compose path.
if [ -n "${CLAUDE_CODE_REMOTE:-}" ] && [ "${QA_MODE:-native}" != "docker" ] || [ "${QA_MODE:-}" = "native" ]; then
  exec "$(dirname "${BASH_SOURCE[0]}")/qa-native.sh" "$@"
fi

# This script DELETES the compose volumes (database, uploads). Refuse to run
# on a real machine unless explicitly allowed.
if [ "${QA_ALLOW_RESET:-0}" != "1" ] && [ -z "${CLAUDE_CODE_REMOTE:-}" ]; then
  echo "Refusing: qa.sh wipes the docker compose volumes (database)." >&2
  echo "Set QA_ALLOW_RESET=1 to confirm (cloud agent VMs are detected automatically)." >&2
  exit 2
fi

cleanup() {
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f .env.qa-generated .env 2>/dev/null || true
  fi
}

# Use a throwaway .env so a QA run never touches real secrets.
if [ ! -f .env ]; then
  touch .env.qa-generated
  trap cleanup EXIT
fi

# Cloud VMs start without the Docker daemon running.
# shellcheck source=scripts/agent/gh-rest.sh
source "$(dirname "${BASH_SOURCE[0]}")/gh-rest.sh"
ensure_docker

echo "== starting fresh demo stack"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
./install.sh --demo

echo "== running Playwright"
cd e2e
npm install --no-audit --no-fund --silent
if [ -z "${CHROME_PATH:-}" ]; then
  npx playwright install chromium
fi
CI=1 npx playwright test "$@"
echo "== QA passed"
