#!/bin/sh
# Pre-install checks shared by the deb/rpm scripts and the one-line installer.
# Prints warnings (never fails the package install). Usage: preflight.sh [port]
port="${1:-1995}"; rc=0
if ! command -v docker >/dev/null 2>&1; then echo "nventra-pos: Docker is not installed; install Docker Engine and the Compose plugin." >&2; rc=1
elif ! docker compose version >/dev/null 2>&1; then echo "nventra-pos: the Docker Compose plugin is missing." >&2; rc=1; fi
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]$port\$"; then
  # Our own running service legitimately holds the port.
  if ! systemctl is-active --quiet nventra-pos.service 2>/dev/null; then
    echo "nventra-pos: port $port is already in use; set HOST_PORT in /etc/nventra-pos/nventra-pos.env." >&2; rc=1
  fi
fi
exit $rc
