# Upgrading

Release notes for changes that affect existing installs. Newest first.

## Image names from 1.1.0

The 1.0.x images remain published under `ghcr.io/canteenx/nodedr-restaurant-pos-backend`
and `ghcr.io/canteenx/nodedr-restaurant-pos-web`. Version 1.1.0 uses the new
`ghcr.io/canteenx/nventra-pos-backend` and `ghcr.io/canteenx/nventra-pos-web`
packages. Apply the updated installation definition as described below; the old
in-app updater cannot add `db-setup`. Do not remove existing volumes.
An existing v1.0.1 installation may nevertheless offer the new image in its
in-app updater. Do not use the in-app updater for this transition. Apply the
new installation definition first. The old updater's rollback was not tested
end to end against a registry.

After the release publishes, inspect both multi-architecture manifests with
`docker buildx imagetools inspect ghcr.io/canteenx/nventra-pos-backend:1.1.0`
and `docker buildx imagetools inspect ghcr.io/canteenx/nventra-pos-web:1.1.0`.
After the owner makes both GHCR packages public, verify an anonymous pull of
each versioned image. These new image names will not exist until publication.

## Back up and roll back a v1.0.1 Docker install

Schedule downtime and stop POS writes before the backup. Preserve the existing
Compose definition, project name, volume names and configuration securely, along
with a verified copy of the v1.0.1 application images. Do not print credentials.
The v1.0.1 application supports S3-compatible backups via Settings > Backup;
configure a reachable bucket, create a backup, and confirm completion and the
stored database and uploads files. Test recovery on a separate disposable stack.
Keep a separate off-host copy. The local scheduled backup described in
[BACKUPS.md](BACKUPS.md) is a separate feature.

For a stock Docker Compose clone, also take a PostgreSQL custom-format dump
and copy the uploads while writes are stopped. The stock service, user and
database names below may differ for an older or customised install. Run from
the original Compose project directory, select a new private backup directory
outside the project, and ensure sufficient disk space:

```sh
umask 077
mkdir -p /secure/off-host-backup
docker compose exec -T postgres pg_dump -U nventra -d nventra_pos -Fc > /secure/off-host-backup/pre-upgrade.dump
docker compose cp backend:/data/uploads /secure/off-host-backup/uploads
```

Before upgrading, record the actual images backing the running stock containers
and export those images alongside the backup. Inspect the names first with
`docker compose ps`; substitute the correct names for a customised project.
The following stock names are fixed by the v1.0.1 Compose definition:

```sh
cd /secure/off-host-backup
docker inspect --format '{{.Image}}' nventra-pos-postgres > postgres-image-id.txt
docker inspect --format '{{.Image}}' nventra-pos-backend > backend-image-id.txt
docker inspect --format '{{.Image}}' nventra-pos-web > web-image-id.txt
docker image save -o recovery-images.tar "$(cat postgres-image-id.txt)" "$(cat backend-image-id.txt)" "$(cat web-image-id.txt)"
sha256sum recovery-images.tar postgres-image-id.txt backend-image-id.txt web-image-id.txt > recovery-images.sha256
```

Confirm each ID is a full `sha256:` image ID and that `recovery-images.tar` is
nonempty. Copy the image archive, ID files and checksum file to protected
off-host storage together, independently retain their expected checksums, and
test loading them on the separate recovery host. Image archives may include
proprietary configuration or assets; protect them and do not export containers.

Replace the example path with a protected destination and securely copy it
off-host. Confirm the dump is nonempty and readable with `pg_restore --list`
using a compatible PostgreSQL client; verify the uploads copy. Test both on a
separate disposable restore before upgrading. Protect these files as customer
data and preserve the original backup separately.

If a rollback is required, stop traffic and take another copy of the current
database and uploads for investigation. Restoring the pre-upgrade backup loses
writes after the backup, including bills and payments. Reconcile them using
business records. Never drop or overwrite the only copy of the current database.

The following stock-clone recovery uses a **separate recovery host**, a new,
isolated Compose project name, and new database and uploads volumes. Rehearse it
on a disposable host first. The preserved v1.0.1 definition has fixed container
names: stopped containers still reserve those names. A different project name
alone does not isolate them. Confirm the recovery host has no containers or
ports colliding with that definition. Do not use this procedure for an
external database, CasaOS, Debian, or customised service/volume names without
adapting and testing it. Use the preserved, verified v1.0.1 definition and
images, not a mutable `latest` tag. On that host, compare the transferred
checksum file against the independently retained expected checksums, then run
`sha256sum -c recovery-images.sha256` in the backup directory. Only after all
four checks succeed, load the verified archive with `docker image load -i
recovery-images.tar`. Compare `docker image inspect IMAGE --format '{{.Id}}'`
for each loaded image to the corresponding verified ID file. Export the three
resulting full `sha256:...` IDs as
`RECOVERY_BACKEND_IMAGE_ID`, `RECOVERY_WEB_IMAGE_ID`, and
`RECOVERY_POSTGRES_IMAGE_ID` in the shell. Do not use a tag or an unverified ID.
In a separate recovery directory containing the preserved Compose definition,
create a `recovery-images.yml` override (not an environment file):

```yaml
services:
  postgres:
    image: ${RECOVERY_POSTGRES_IMAGE_ID:?set verified PostgreSQL image ID}
    pull_policy: never
  backend:
    image: ${RECOVERY_BACKEND_IMAGE_ID:?set verified backend image ID}
    pull_policy: never
  web:
    image: ${RECOVERY_WEB_IMAGE_ID:?set verified web image ID}
    pull_policy: never
```

Set `COMPOSE_FILE=docker-compose.yml:recovery-images.yml` in the POSIX shell
(on Windows use the platform's Compose path separator). Check `docker compose
config --images` resolves to the three verified IDs before starting; if it
includes the unused updater, do not start that service. Do not print the full
Compose configuration because it may include credentials. Use `--no-build
--pull never` with every `up` command. Run from that recovery directory with its
required configuration already available. Substitute the secure backup path:

```sh
docker compose -p nventra-recovery up -d --no-build --pull never postgres
docker compose -p nventra-recovery exec -T postgres pg_isready -U nventra -d postgres
docker compose -p nventra-recovery exec -T postgres psql -v ON_ERROR_STOP=1 -U nventra -d nventra_pos -c 'SELECT 1'
# Inspect the mount and confirm its identity as described below before continuing.
docker inspect --format '{{json .Mounts}}' nventra-pos-postgres
# Only on the new recovery volume, replace its empty initial database.
docker compose -p nventra-recovery exec -T postgres dropdb -U nventra --if-exists nventra_pos
docker compose -p nventra-recovery exec -T postgres createdb -U nventra -O nventra nventra_pos
docker compose -p nventra-recovery exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges -U nventra -d nventra_pos < /secure/off-host-backup/pre-upgrade.dump
docker compose -p nventra-recovery up -d --no-build --pull never backend
# Inspect the uploads mount and confirm its identity before copying.
docker inspect --format '{{json .Mounts}}' nventra-pos-backend
docker compose -p nventra-recovery cp /secure/off-host-backup/uploads/. backend:/data/uploads/
docker compose -p nventra-recovery up -d --no-build --pull never web
```

The `--no-owner --no-privileges` options restore objects as the stock `nventra`
superuser without importing grants for roles that may be absent. Custom grants
must be reviewed and restored separately; this runbook is for stock installs.
Before `dropdb`, inspect the running recovery PostgreSQL container's actual
mounts with `docker inspect --format '{{json .Mounts}}' nventra-pos-postgres`.
Confirm `/var/lib/postgresql/data` is a newly created recovery volume, not the
original or an existing volume. Before copying uploads, inspect the backend's
actual mounts with `docker inspect --format '{{json .Mounts}}' nventra-pos-backend`
and confirm `/data/uploads` is a separate new recovery volume. Compare the
source volume identities to those recorded for the original project; stop if
either source matches or is unclear. A project name or `compose ps` alone is
not proof of isolation. The drop applies only to that recovery
database. Check every command for errors. Compare restored row counts and
uploads checksums against the backup, then verify login, orders and served
uploads on the isolated recovery instance before directing users to it. Preserve
both old and upgraded volumes until recovery and reconciliation are complete.
The independent QA drill restored the pre-upgrade dump to the old definition
and verified its data; adapt the exact recovery project and routing to the site.

The old backend runs with the stock database superuser again. The roles
`nventra_owner`, `nventra_runtime` and `nventra_restore` can remain in the
database after rollback. Preserve them for a subsequent upgrade; do not delete
roles or volumes as a cleanup step. CasaOS and Debian upgrade/rollback paths,
external databases and a real registry-backed updater rollback were not
covered by this Docker-clone drill.

## Separate database logins for stock Docker installs (#249)

Apply the updated Compose project, CasaOS manifest or Debian package for this
upgrade. The earlier in-app updater preserves the old container's configuration
and cannot add the database setup service. For a cloned install, run `git pull`
and `./install.sh`. For CasaOS, stop the backend and apply the new store
definition with the same AppData paths and existing Postgres password. For an
existing Debian installation, upgrade the package. Keep your existing database
and uploads volumes and take a backup before upgrading.

The one-shot `db-setup` service keeps the existing PostgreSQL bootstrap
password. It handles pre-rename volumes and migrates the app schema as
`nventra_owner`. The backend uses a generated `nventra_runtime` login from a
read-only volume. Restore uses its own restricted login. Subsequent in-app
updates run `db-setup` from the selected backend version before starting it.
The updater pins setup and the backend to the same downloaded image. If an
update fails, it reruns setup from the previously running image before
restarting that backend. A `rollback_failed` status means the database
still needs operator attention. If the previous setup failed, the backend
stays stopped. Correct the cause and apply the matching Compose definition.

If setup fails, inspect `docker compose logs db-setup` and verify the database,
the original bootstrap credentials and migration state. Correct the problem
and rerun the installer or `docker compose up -d`. An existing `DATABASE_URL`
using an external database follows the existing operator-managed startup path.

## Multi-branch sync: per-branch keys, ownership, store-credit ledger (#82)

**Upgrade HQ first, then each branch.** A branch whose app version differs
from HQ's pauses transfer (Settings > Sync shows "App versions differ … Update
this branch") and keeps queuing its changes until both match. Nothing is lost
or rejected while paused.

**Branches register once.** A branch that was syncing with the shared
`SYNC_API_KEY` registers itself at HQ on its first cycle after the update and
from then on uses its own key. HQ stores that key only as a hash, and
the branch forgets the shared key. If HQ has more than one branch, that first
cycle asks which branch this install runs ("Choose which branch …"). Enable
sync again from Settings > Sync and pick the branch. HQ allows one install per
branch. A lost or replaced branch PC is cut off at HQ with
`POST /api/v1/sync/peers/:id/revoke`, without changing anyone else's key.

**HQ only takes what a branch owns.** A branch can no longer change the menu,
prices, roles, staff or another branch's data through sync. Such changes are
reported as `not-owner` conflicts and kept on the branch in `sync_rejected`.

**Store credit has a ledger.** The migration `20261105100000_sync_apply` adds
`customer_wallet_entries` and opens it with one `OPENING` entry for each
customer with a non-zero `walletBalance`, so the balance equals the ledger
from day one. Store-credit refunds now add an entry and set the balance to
the rounded sum, under the customer row lock. The migration only adds tables
and columns. `prisma/migrations/20261105100000_sync_apply/down.sql` reverses
it, and `walletBalance` keeps its value either way.

**HQ checks settled orders.** HQ does not reprice a branch's orders. A PAID
order whose lines, total and payments don't add up is flagged. Flagged orders
are counted in `GET /api/v1/sync/status` (`flaggedOrders`) and listed in
`GET /api/v1/sync/flags`.

## Nventra rename: Postgres user and database (#4, #143)

**What changed.** The compose files (`docker-compose.yml`,
`casaos/docker-compose.yml`, `packaging/deb/docker-compose.yml`) now create the
Postgres role `nventra` and database `nventra_pos`, and the backend's
`DATABASE_URL` points at them. Earlier installs have `nodedr` /
`nodedr_restaurant`.

**What happens on upgrade.** Postgres applies `POSTGRES_USER` / `POSTGRES_DB`
only when it creates an empty data directory, so an existing volume keeps the
old names. The backend container now runs a one-off step before its database
migrations (`apps/backend/src/system/db-identity-upgrade.ts`):

1. If `nventra` can log in, nothing happens (new installs, or already upgraded).
2. Otherwise, if `nodedr` can log in with the same password, it renames the
   role `nodedr` -> `nventra` and the database `nodedr_restaurant` ->
   `nventra_pos`, and sets the role's password again from `DATABASE_URL`.
   Tables, data, ownership and grants are unchanged. An install that never set
   `POSTGRES_PASSWORD` uses the compose default, which changed from
   `nodedr_dev_pw` to `nventra_dev_pw`. In that case the old default is also
   tried for `nodedr`, and the role gets the new default. To do this it creates a
   short-lived helper superuser `nventra_identity_upgrade` with the same
   password, and drops it when it is done.
3. If neither can log in, it changes nothing and `prisma migrate deploy` reports
   the connection error as before.

On builds that ran the rename from the backend, `DbIdentityUpgrade` logged one line, for
example `renamed Postgres role nodedr -> nventra and database
nodedr_restaurant -> nventra_pos` on the first start after the upgrade and
`database identity is current` afterwards. The step is idempotent: if the
container stops halfway, the next start finishes the job.

It only acts when `DATABASE_URL` uses exactly the `nventra` user and the
`nventra_pos` database. A custom `DATABASE_URL` (another user, database or
external Postgres) is left alone.

**Healthcheck.** The Postgres healthcheck is `pg_isready -U nventra -d
nventra_pos`. `pg_isready` checks only that the server accepts connections. It
does not log in, so the check passes on an old volume before the rename and
after it. The backend therefore starts, and the rename can run.

**Sign in again.** The session cookie is now `nventra_session`, so everyone
signs in once after the update.

Apply the current Compose project for the database-role upgrade above. Its
setup job runs the identity rename before applying the new roles.

**Local development.** If your dev Postgres volume predates the rename, point
`apps/backend/.env` at `nventra` / `nventra_pos` (see `.env.example`) and run
`pnpm --filter ./apps/backend db:upgrade-identity` once.

**If it reports a problem.**
- `role "nventra" already exists but DATABASE_URL's password does not log in to
  it`: a separate `nventra` role was created by hand. Remove it or fix its
  password, then restart the backend.
- To check the upgrade path yourself: `scripts/test-db-identity-upgrade.sh`
  starts a throwaway old-identity Postgres with demo data, upgrades it, and
  checks the data, the healthcheck and the login.
