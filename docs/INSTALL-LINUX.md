# Install on Linux (deb and rpm)

Ubuntu/Debian get a `.deb`; RHEL, Fedora, Rocky and Alma get an `.rpm`. Both install a
systemd service (`nventra-pos`) that runs the version-pinned containers with Docker Compose.

## One line
```bash
curl -fsSL https://raw.githubusercontent.com/CanteenX/restaurant-pos/master/packaging/deb/install-linux.sh | sudo bash
```
Pin a version with `NVENTRA_VERSION=X.Y.Z`. The script checks Docker, Docker Compose and that
port 1995 is free, verifies the package SHA-256, installs it and starts the service.
Open http://localhost:1995 (first start pulls images and can take a few minutes).

## Manage
- Status/logs: `systemctl status nventra-pos`
- Settings: `/etc/nventra-pos/nventra-pos.env` (mode 600, secrets generated once), then `sudo systemctl restart nventra-pos`
- Uninstall, keeping data and settings: `sudo bash install-linux.sh --uninstall`
- Uninstall and delete everything: `sudo bash install-linux.sh --uninstall --purge-data`

## Build locally
```bash
packaging/deb/build.sh 1.2.3            # deb for amd64+arm64; also rpm when rpmbuild is installed (RPM=0 skips)
packaging/deb/build-rpm.sh 1.2.3        # rpm only (needs rpmbuild)
STATIC=1 packaging/deb/test.sh          # fast checks, no root or Docker
sudo DEB=dist/nventra-pos_1.2.3_amd64.deb packaging/deb/test.sh   # full install/upgrade/remove/purge test
```
Packages are not signed and there is no hosted repository yet.

Note: `.github/workflows/deb.yml` is disabled and still uses the old `nodedr-orderrestro` names; update it to `nventra-pos` before re-enabling.
