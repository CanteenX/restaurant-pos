#!/usr/bin/env bash
# Claude cloud environment setup script (paste into the environment's "setup
# script" in claude.ai/code). Runs before each session and is cached as a
# filesystem snapshot if it finishes in ~5 min. No background processes, no
# secrets here.
set -euo pipefail

corepack enable
corepack prepare pnpm@11.10.0 --activate

# Pre-pull base images so `./install.sh --demo` builds faster in sessions.
docker pull -q postgres:16-alpine || true
docker pull -q node:22-alpine || true
docker pull -q docker:cli || true
docker pull -q alpine:3.20 || true

# GitHub CLI is used by every agent role.
command -v gh >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq gh)

echo "setup done: node $(node -v), pnpm $(pnpm -v), docker $(docker --version | cut -d' ' -f3)"
