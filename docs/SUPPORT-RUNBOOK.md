# Support runbook

For support staff diagnosing the most common failures at a customer site,
without a developer. Commands assume a terminal on the host machine, in the
folder that holds `docker-compose.yml` and `.env`. Every step below cites
either a command or a UI path that exists in this repository.

Service names (from `docker-compose.yml`): `postgres`, `backend`, `web`,
`updater`. Container names: `nventra-pos-postgres`, `nventra-pos-backend`,
`nventra-pos-web`, `nventra-pos-updater`.

## Quick triage

```bash
docker compose ps                                  # all four services should show "running"; postgres "healthy"
curl -sf http://localhost:1995/api/health && echo OK   # 1995 = HOST_PORT default in .env
docker compose logs --tail=200 backend            # most failures show up here
```

If `/api/health` does not answer, go to [1](#1-app-not-responding) first.

## Where logs are

| What | Command |
|---|---|
| Backend (API, email, printing, backups, updates) | `docker compose logs -f backend` |
| Web (browser-facing server, `/api` and `/socket.io` proxy) | `docker compose logs -f web` |
| Database | `docker compose logs -f postgres` |
| In-app updater | `docker compose logs -f updater` |
| Install script (first run) | Re-run `./install.sh`; it prints the logs command if the app does not come up within 90 s |

Collect logs with `docker compose logs --no-color --since 24h > support-logs.txt`
(see [What to collect](#what-to-collect-for-escalation)).

## 1. App not responding

1. `docker compose ps`. A container that is `restarting` or `exited` is the problem.
2. `docker compose up -d` brings missing or stopped containers back without
   rebuilding data volumes.
3. `docker compose logs --tail=200 backend` and look for the first error after startup.

## 2. Restart a container

```bash
docker compose restart backend     # or web, postgres
docker compose restart             # all services; data volumes are kept
```

Do not run `docker compose down -v`: the `-v` flag deletes the `pg_data` and
`uploads_data` volumes (all sales data and uploaded images).

## 3. Database not reachable

The backend reaches Postgres at `postgres:5432` on the internal Docker network;
the database is not published to the host (`docker-compose.yml`, `postgres` service).

```bash
docker compose exec postgres pg_isready -U nventra -d nventra_pos   # "accepting connections" = healthy
docker compose logs --tail=100 postgres
```

- If `pg_isready` fails, `docker compose restart postgres`, then `backend`.
- If the backend logs show an authentication error, `POSTGRES_PASSWORD` in `.env`
  no longer matches the password the `pg_data` volume was created with. Restore the
  original value in `.env`; do not change it on a running database.

## 4. Forgot password

The backend has no self-service "forgot password" email flow yet (planned in #224).
Someone with **strictly more access** than the staff member sets a new password.
That is an owner, or a manager whose permissions include all of the staff member's
permissions and at least one more. A peer at the same level cannot do it.

1. Open the staff member's record in the app's staff page and set a new password (at least 8 characters).
   This calls `PATCH /api/v1/users/:id` (`apps/backend/src/modules/users/users.controller.ts`).
2. Tell the staff member to sign in with email and the new password.

Changing **your own** password through the same endpoint needs `currentPassword`. That
check is limited like sign-in: 5 tries a minute per account and per address. After
5 wrong passwords, these checks are locked for that account for 15 minutes. The lock
also covers deleting your own account and turning off 2FA, but not sign-in. A
backend restart clears it.

### Owner password lost

If there is another owner, they reset it on the staff page. If the only owner forgot
their password, someone with **shell access to the server** runs:

```sh
# Docker install (from the folder with docker-compose.yml)
docker compose exec backend ./container-entrypoint.sh node dist/src/system/reset-owner-password.cli.js --email owner@example.com

# From a source checkout (DATABASE_URL set)
pnpm --filter ./apps/backend run reset-owner-password -- --email owner@example.com
```

- It only works on an OWNER account.
- It generates a new password and prints it once.
- It signs that owner out of every device (`tokenVersion` + 1).
- It writes an `owner.password_reset_cli` entry to the audit log. The password itself is never logged.
- If the same email is an owner in more than one restaurant on the server, add `--restaurant <id>`.
- Give the password to the owner over a private channel.
- Do not edit the database by hand.

The script does not clear two-factor. If the owner also lost their authenticator, they
sign in with a recovery code. If they have no recovery code, escalate (see
[What to collect](#what-to-collect-for-escalation)).

## 5. Forgot PIN or PIN login blocked

PIN login (`POST /api/v1/auth/pin-login`) locks after repeated failures for
**15 minutes** (`PIN_LOCK_MS` in `apps/backend/src/auth/auth.service.ts`), keyed
per user and per IP. Wait 15 minutes, then try again with the correct PIN.

To change a PIN, an owner or administrator edits the staff member on the staff page.
If the lock persists after 15 minutes, restart the backend (`docker compose restart backend`):
the lock counters are held in memory (`apps/backend/src/auth/failure-lockout.ts`), so a restart clears them.

## 6. Two-factor (authenticator) lost

An owner, or a manager with strictly more access than the staff member, resets
the staff member's two-factor setup:
`POST /api/v1/auth/2fa/reset/:userId` (requires `users.manage`,
`apps/backend/src/auth/auth.controller.ts`). The staff member then sets up
the authenticator again at their next sign-in.

## 7. Printer not printing

Thermal printing is sent by the **backend**, not the browser
(`docs/PERMISSIONS-STOCK-PRINTING.md`, "Connection").

1. Settings → Thermal printer → Connection. Note whether it is set to **USB** or **Network**.
2. Press **Test kitchen ticket**. The error text appears inline. A `503` response
   means the printer could not be reached; the reason is in the message and in
   `lastPrintError` on the ticket.
3. **Network printer:** the restaurant must have `printerHost` reachable from the
   backend host. Check with `ping <printer-ip>` from the server, and confirm the port
   (default **9100**). Settings shows "Printer reachable at host:port" when it works.
4. **USB printer:** the server must see the device. On the host, `ls -l /dev/usb/lp0`
   (kernel driver) or `lsusb`. The backend container mounts `/dev/bus/usb` and is
   granted the usb device cgroups in `docker-compose.yml`; after unplugging and
   replugging, the `backend` container normally needs no restart.
5. Reprints: a ticket that already printed is blocked with `409 ALREADY_PRINTED`
   unless it is reprinted on purpose (`?reprint=true`, or the KDS ticket's printer button).
6. If the restaurant uses the cloud, a USB printer or a private LAN printer is
   not reachable from the server. Use the browser print buttons, or a VPN to the
   restaurant network.

## 8. Kitchen display (KDS) not updating

The KDS updates over Socket.IO (`/socket.io`, proxied by the `web` container;
gateway in `apps/backend/src/realtime/realtime.gateway.ts`).

1. Reload the KDS tablet page. If it updates after a reload, the live connection dropped
   and the client will reconnect on its own; check the tablet's Wi-Fi.
2. Check the address the tablet uses. The backend only accepts browser origins listed in
   `FRONTEND_ORIGIN` (written to `CORS_ORIGIN` in `docker-compose.yml`). If the tablet
   opens the site under a different address (IP, tunnel or domain), set `FRONTEND_ORIGIN`
   in `.env` to that address and run `docker compose up -d backend`.
3. Behind a tunnel or reverse proxy, set `WEB_TRUST_PROXY` (see `docs/website-integration.md`).
4. Check `docker compose logs --tail=100 backend` for `realtime` or CORS errors.

Setup details for kiosk and KDS tablets: `docs/KIOSK-AND-KDS.md`.

## 9. Email not sending

Email is disabled when `SMTP_URL` or `SMTP_FROM` is empty in `.env`
(`docker-compose.yml`, `backend` service). Setup, including the Gmail app-password:
`docs/email.md`.

1. `docker compose logs backend | grep "Email to"`. A failed send logs
   `Email to <address> failed: <reason>` (`apps/backend/src/modules/email/email.service.ts`).
2. `Email is not set up: set SMTP_URL and SMTP_FROM` means the variables are empty.
3. In `SMTP_URL`, URL-encode the `@` in the username (`user%40gmail.com`).
4. After editing `.env`, run `docker compose up -d backend`.

## 10. Backup not running or failing

Backups go to an S3-compatible bucket, configured in Settings → Backup (or with
`S3_BACKUP_*` variables in `.env`). Without that configuration the app reports
"S3 backup is not configured".

1. Settings → Backup: check the status and the last backup.
2. `docker compose logs --tail=200 backend | grep -i backup` for the error.
3. Check the endpoint, bucket and key in Settings → Backup. A rejected key or a wrong
   bucket name is the usual cause.

## 11. Restore a backup (owner only)

Restore replaces the database and the uploads with the backup's contents. It is
destructive. Only the **Owner** can restore; the app refuses for any other role.

1. Take a fresh backup first if the current data is still wanted.
2. Settings → Backup → choose a backup with status *verified* → Restore.
   This calls `POST /api/v1/backups/:id/restore` with `confirm: "RESTORE"`.
3. The backend checks every object's checksum before anything is changed. A mismatch stops
   the restore with no change to the database.
4. The app may be briefly unavailable. Owners get a "Restore started" notification.

## 12. Update failed or the app is broken after an update

The in-app update (Settings → Updates → Update now) is done by the `updater`
container (`updater/server.js`). It starts the new backend and web containers and,
if starting the new one fails, **rolls back automatically**: it removes the
new containers and starts the previous ones again. Data volumes are not touched.

1. `docker compose logs --tail=200 updater` for the failed step.
2. Check `docker compose ps`. If the old version is running, the rollback worked;
   retry the update later or escalate.
3. Manual rollback is not automated here. Escalate before attempting it, and record the
   `APP_VERSION` value in `.env` first.

## 13. Disk or uploads problems

Uploaded images live in the `uploads_data` volume (`UPLOADS_DIR=/data/uploads`).
Check space with `docker system df` and `df -h`. Do not delete volumes to free space.

## What to collect for escalation

Send this to the developer or partner support:

1. Output of `docker compose ps` and the app version (`APP_VERSION` in `.env`).
2. `docker compose logs --no-color --since 24h > support-logs.txt`. Remove any line that
   holds a password, a token or the contents of `.env`.
3. What the staff member did just before the failure, and the time it happened.
4. The printer model and connection type (USB or network), or the email provider.
5. Whether a backup was taken in the last 24 hours (Settings → Backup).

Never send `.env` itself: it holds `JWT_SECRET` and the database password.

## Related docs

- `docs/PARTNER-INSTALL-GUIDE.md`: first install and go-live checklist
- `docs/PERMISSIONS-STOCK-PRINTING.md`: printer connection details
- `docs/KIOSK-AND-KDS.md`: kiosk and KDS tablets
- `docs/email.md`: SMTP setup
