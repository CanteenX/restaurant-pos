#!/usr/bin/env bash
# One-command install of Nventra POS on Ubuntu/Debian (.deb) or RHEL, Fedora, Rocky, Alma (.rpm); amd64 or arm64.
#
#   curl -fsSL https://raw.githubusercontent.com/CanteenX/restaurant-pos/master/packaging/deb/install-linux.sh | sudo bash
#
# Downloads the package for the latest release from GitHub, checks its SHA-256, makes sure Docker and Docker Compose
# are present, and installs the package. It starts Nventra POS under systemd (it runs in Docker)
# and it is then available at http://localhost:1995.
# Pin a version:  ... | sudo NVENTRA_VERSION=X.Y.Z bash
# Read it first:  curl -fsSL <url above> | less
# Use a file you already downloaded (it must sit next to its .sha256):  sudo PKG_FILE=./nventra-pos_X.Y.Z_amd64.deb bash install-linux.sh
# Uninstall (keeps your data and settings):  sudo bash install-linux.sh --uninstall
# Uninstall and delete data and settings:    sudo bash install-linux.sh --uninstall --purge-data
set -euo pipefail

REPO="CanteenX/restaurant-pos"
PKG="nventra-pos"
say() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: curl -fsSL https://raw.githubusercontent.com/CanteenX/restaurant-pos/master/packaging/deb/install-linux.sh | sudo bash"
[ -r /etc/os-release ] && . /etc/os-release
FAMILY=""
case "${ID:-}:${ID_LIKE:-}" in
  debian:*|ubuntu:*|*:*debian*|*:*ubuntu*) FAMILY=deb ;;
  rhel:*|fedora:*|rocky:*|almalinux:*|centos:*|*:*rhel*|*:*fedora*) FAMILY=rpm ;;
esac
[ -n "$FAMILY" ] || die "This installer is for Ubuntu/Debian and RHEL-family systems. For other systems use Docker: https://github.com/CanteenX/restaurant-pos"
{ command -v systemctl >/dev/null && [ -d /run/systemd/system ]; } || die "systemd is required. In a container or WSL without systemd, use Docker Compose instead: https://github.com/CanteenX/restaurant-pos"

if [ "${1:-}" = "--uninstall" ]; then
  say "Removing $PKG (your data and settings are kept)"
  if [ "$FAMILY" = deb ]; then apt-get remove -y "$PKG"; else (dnf remove -y "$PKG" 2>/dev/null || yum remove -y "$PKG"); fi
  if [ "${2:-}" = "--purge-data" ]; then
    say "Deleting data volumes and settings"
    docker compose --project-name "$PKG" down -v >/dev/null 2>&1 || true
    rm -rf "/etc/$PKG"
  else
    say "Kept: /etc/$PKG/$PKG.env and the Docker volumes. Delete them with --uninstall --purge-data."
  fi
  exit 0
fi

if [ "$FAMILY" = deb ]; then
  command -v apt-get >/dev/null || die "apt-get was not found."
  ARCH="$(dpkg --print-architecture)"; EXT=deb
else
  PM=dnf; command -v dnf >/dev/null || PM=yum; command -v "$PM" >/dev/null || die "dnf or yum was not found."
  case "$(uname -m)" in x86_64) ARCH=x86_64 ;; aarch64) ARCH=aarch64 ;; *) ARCH="$(uname -m)" ;; esac; EXT=rpm
fi
case "$ARCH" in amd64|arm64|x86_64|aarch64) ;; *) die "Unsupported CPU architecture '$ARCH' (amd64 and arm64 are published)." ;; esac

export DEBIAN_FRONTEND=noninteractive
say "Installing prerequisites"
if [ "$FAMILY" = deb ]; then apt-get update -qq; apt-get install -y -qq curl ca-certificates >/dev/null
else "$PM" install -y -q curl ca-certificates >/dev/null; fi

# Docker Engine and the Compose plugin: use what is installed, else the distribution's packages, else Docker's own repository.
if ! { command -v docker >/dev/null && docker compose version >/dev/null 2>&1; }; then
  say "Installing Docker and Docker Compose"
  if [ "$FAMILY" = deb ]; then
    if ! { apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1; }; then
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
    fi
  else
    DREPO=centos; [ "${ID:-}" = fedora ] && DREPO=fedora; [ "${ID:-}" = rhel ] && DREPO=rhel
    curl -fsSL "https://download.docker.com/linux/${DREPO}/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo
    "$PM" install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "Docker Compose is still unavailable. See https://docs.docker.com/engine/install/ and run this again."

# Is the port free? (our own running service may hold it on a re-run)
if command -v ss >/dev/null && ss -ltn | awk '{print $4}' | grep -q '[:.]1995$' && ! systemctl is-active --quiet "$PKG.service"; then
  die "Port 1995 is already in use. Free it, or install and then set HOST_PORT in /etc/$PKG/$PKG.env."
fi

WORK="$(mktemp -d /var/tmp/nventra-pos-install.XXXXXX)"; chmod 0755 "$WORK"; trap 'rm -rf "$WORK"' EXIT
PKG_FILE="${PKG_FILE:-${DEB_FILE:-}}"
if [ -n "$PKG_FILE" ]; then
  [ -f "$PKG_FILE" ] || die "PKG_FILE '$PKG_FILE' does not exist."
  FILE="$(basename "$PKG_FILE")"; cp "$PKG_FILE" "$WORK/$FILE"
  [ -f "$PKG_FILE.sha256" ] && cp "$PKG_FILE.sha256" "$WORK/$FILE.sha256" || die "Put $FILE.sha256 next to the file so it can be verified."
else
  VERSION="${NVENTRA_VERSION:-}"
  if [ -z "$VERSION" ]; then
    say "Finding the latest release"
    # The /releases/latest redirect has no API rate limit (shared networks get HTTP 403 from api.github.com); the API is the fallback.
    VERSION="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null | sed -n 's|.*/releases/tag/v\{0,1\}||p' || true)"
    [ -n "$VERSION" ] || VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
    [ -n "$VERSION" ] || die "Could not determine the latest version. Set NVENTRA_VERSION, for example NVENTRA_VERSION=1.8.1."
  fi
  VERSION="${VERSION#v}"
  if [ "$EXT" = deb ]; then FILE="${PKG}_${VERSION}_${ARCH}.deb"; else FILE="${PKG}-${VERSION}-1.${ARCH}.rpm"; fi
  BASE="https://github.com/$REPO/releases/download/v${VERSION}"
  say "Downloading Nventra POS $VERSION ($ARCH)"
  curl -fSL --retry 3 -o "$WORK/$FILE" "$BASE/$FILE" || die "Could not download $BASE/$FILE"
  curl -fsSL -o "$WORK/$FILE.sha256" "$BASE/$FILE.sha256" || die "Could not download the checksum file."
fi
( cd "$WORK" && sha256sum -c "$FILE.sha256" >/dev/null ) || die "Checksum mismatch: the download is damaged. Nothing was installed."
chmod 0644 "$WORK/$FILE"

say "Installing (the first start pulls the container images and can take a few minutes)"
if [ "$FAMILY" = deb ]; then apt-get install -y "$WORK/$FILE"; else "$PM" install -y "$WORK/$FILE"; fi
say "Done. Open http://localhost:1995  ·  status: systemctl status $PKG  ·  settings: /etc/$PKG/$PKG.env"
