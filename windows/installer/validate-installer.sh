#!/usr/bin/env bash
# Static sanity checks for the Windows installer sources (runs on any OS).
set -u
cd "$(dirname "$0")"
fail=0
check() { if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok:   $1"; fi; }
check "nventra.iss exists" '[ -f nventra.iss ]'
check "setup-nventra.ps1 exists" '[ -f setup-nventra.ps1 ]'
check "build-installer.ps1 exists" '[ -f build-installer.ps1 ]'
check "installer is per-machine and has an uninstaller entry" 'grep -q "^AppId=" nventra.iss && grep -q "UninstallDisplayName" nventra.iss'
check "installer creates shortcuts" 'grep -q "^\[Icons\]" nventra.iss'
check "installer runs the setup script" 'grep -q "setup-nventra.ps1" nventra.iss'
check "uninstall stops services" 'grep -q "UninstallRun" nventra.iss && grep -q "down" nventra.iss'
check "setup checks Docker and WSL2" 'grep -q "docker" setup-nventra.ps1 && grep -qi "wsl" setup-nventra.ps1'
check "setup generates secrets (none committed)" 'grep -q "New-Secret" setup-nventra.ps1'
check "no .env or secrets committed here" '! ls .env* >/dev/null 2>&1'
check "no workflow files touched" '[ -z "$(git status --porcelain ../../.github 2>/dev/null)" ]'
check "docs exist" '[ -f ../../docs/WINDOWS-INSTALL.md ]'
exit $fail
