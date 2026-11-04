# Installing Nventra POS on Windows

## For restaurant owners
1. Install Docker Desktop (or enable WSL2 with `wsl --install`) and restart if asked.
2. Run `NventraPOS-Setup-<version>.exe` and accept the admin prompt.
3. The installer checks WSL2 and Docker, generates secrets into `.env`, and starts the services.
4. Open **Nventra POS** from the Start menu (http://localhost:1995).

If a prerequisite is missing, setup explains what to install; run the installer again afterwards.
Start/Stop shortcuts are in the Start menu. Log: `%ProgramData%\NventraPOS\setup.log`.

## Uninstall
Settings > Apps > Nventra POS. This stops the containers; the database volume is kept
(`docker volume rm` to delete data deliberately).

## For maintainers
- Sources: `windows/installer/` (`nventra.iss`, `setup-nventra.ps1`, `build-installer.ps1`).
- Build on Windows with Inno Setup 6: `./build-installer.ps1 -Version 1.0.0`.
- Static checks (any OS): `windows/installer/validate-installer.sh`.
- Code signing is out of scope (blocked on a certificate). Unsigned builds show SmartScreen warnings.
- Not yet verified in a Windows VM: install/uninstall screenshots are a pending human step.
