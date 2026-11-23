# Upgrading

Release notes for changes that affect existing installs. Newest first.

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
