# Local scheduled backups (USB drive / NAS)

Nventra POS can copy a full backup to a folder you choose — an external USB
drive or a NAS share — on a schedule, so a dead server disk does not take
the only copy of your data with it. This is separate from, and can run
alongside, the S3 bucket backups in **Settings → Backup**.

Each backup is one folder named `nventra-backup-<UTC time>` containing:

| File | What |
|---|---|
| `db.dump` | Postgres custom-format dump (restore through the app into its migrated schema) |
| `uploads.tar.gz` | uploaded images and files |
| `SHA256SUMS` | checksums; check a copy with `sha256sum -c SHA256SUMS` |

Backups are written into a hidden `.partial-…` folder, flushed to disk,
re-read and checksum-verified, and only then renamed into place. A folder
without the `.partial-` prefix is always complete.

## 1. Mount the drive into the backend container

Mount the drive on the host first (for example at `/media/usb-backup`), then
in `docker-compose.yml` uncomment, under the `backend` service:

```yaml
    environment:
      LOCAL_BACKUP_ROOT: "/backups"
    volumes:
      - /media/usb-backup:/backups
```

The folder must be writable from inside the container (on a NAS, export the
share read-write), then run `docker compose up -d backend`. Format USB drives
as ext4 or exFAT; backup folder names contain no `:` so FAT/exFAT work.

`LOCAL_BACKUP_ROOT` is the **allowed root**: it can only be set in the
environment, never from the app, and every backup directory must resolve
inside it. Paths with `..`, other absolute paths and symlinks that point
outside the root are rejected.

## 2. Settings

| Env var | Default | Meaning |
|---|---|---|
| `LOCAL_BACKUP_ROOT` | unset (off) | allowed root, the container mount point |
| `LOCAL_BACKUP_DIR` | root itself | sub-folder inside the root |
| `LOCAL_BACKUP_INTERVAL_HOURS` | `24` | how often (checked hourly, survives restarts) |
| `LOCAL_BACKUP_RETAIN_COUNT` | `7` | newest backups kept; older ones are deleted |
| `LOCAL_BACKUP_ENABLED` | `true` | set `false` to pause without unmounting |

Users with the **Manage Backups** permission can override everything except
the root through the API (saved in the database, audited):

- `GET /api/v1/backups/local/status` — enabled, directory, last success
  time/path/size, last failure time/reason, next run, existing backups.
- `PUT /api/v1/backups/local/config` — `{ enabled?, directory?, intervalHours? (1–168), retainCount? (1–90) }`
- `POST /api/v1/backups/local/run` — back up now.

## 3. Failures

If a run fails (drive unplugged, full, read-only), the status endpoint shows
the time and reason, the last good backup time is kept, and every Owner gets
a **Local backup failed** notification. Scheduled retries happen hourly; the
notification is sent once per outage (and on every failed manual run), not
every hour.

## 4. Restoring a backup (security model)

A restore is destructive and Owner-only. Backups are untrusted input, so:

- **Limited role.** The database is restored as `nventra_restore` (NOSUPERUSER,
  NOCREATEROLE, NOCREATEDB, no predefined `pg_*` memberships, no database or
  schema CREATE, no schema/table/sequence/function ownership or TRIGGER rights;
  only data privileges on the app tables, TEMP for transaction-local counter
  reconciliation, and USAGE/SELECT/UPDATE on sequences). For stock Docker installs, `db-setup`
  provisions the role. Its password is derived from the runtime database
  password, so there is nothing to configure. The database dump uses the
  runtime login, with read access to all application data.
- **`DATABASE_RESTORE_URL`** (optional) points restores at a role you manage.
  The restore is refused unless that role is limited as above, including any
  roles it is a member of.
- **`NVENTRA_ALLOW_UNSAFE_SUPERUSER_RESTORE=1` is DANGEROUS.** It lets a restore
  run as a superuser or otherwise over-privileged role, so a tampered backup in
  your bucket could execute code on the database host. Only use it for a
  one-off recovery you fully trust, then unset it.
- **Data only.** The schema, functions, triggers, roles and extensions in a
  dump are never executed. The app's migrated schema stays; table rows are
  replaced in a single transaction. A failed restore rolls back the
  deletes and copied rows. The app extracts raw COPY bytes to private temporary
  files, verifies table and column names against the live schema, and generates
  its own file-based `\copy` commands. Dump SQL and psql commands never reach
  the psql command parser. Hindi, rupee signs and other UTF-8 data retain their
  original bytes. Extraction enforces configurable line and output budgets;
  see Restore resource limits below. Scratch files are removed after success
  or failure.
- **Sequence counters only move forward.** PostgreSQL sequence changes do not
  roll back. Every live, table-owned sequence is reconciled to the greatest of
  its existing value, the vetted backup value and the largest restored column
  value. All archive values, permissions and final targets are checked before
  any counter is set. Deferred constraints run before counter updates. A failed
  restore may leave harmless forward gaps, as a failed INSERT can, but never
  rewinds an existing counter. Only ascending, noncycling, increment-one app
  sequences are supported. Restore takes exclusive locks on app tables; perform
  it during maintenance without administrative direct `nextval`/`setval` calls.
- **Fiscal ledger.** `verifactu_records` is append-only and hash-chained, so a
  restore never deletes or overwrites it. It is refused if the ledger is not
  empty; restore into a freshly migrated, empty database in that case.
- **Uploads.** `uploads.tar.gz` is checked (no links, no `..`, one root, size
  cap) and extracted into a scratch directory before anything is changed; the
  old uploads are kept aside until the swap succeeds.
- The backup must come from the same schema version as the running app.


### Restore resource limits

Database COPY extraction checks the compressed custom-format dump before loading:
`NVENTRA_RESTORE_MAX_ARCHIVE_BYTES` defaults to 4 GiB. The default decompressed
budget is 128 times the dump size, with a 1 GiB floor and 16 GiB ceiling.
`NVENTRA_RESTORE_MAX_OUTPUT_BYTES` overrides that budget for trusted backups with
unusually high compression. `NVENTRA_RESTORE_MAX_LINE_BYTES` defaults to the smaller
of 64 MiB and the output budget. All three settings accept positive safe integer
byte counts; invalid settings refuse the restore. Errors name the applicable
setting. Output budgets apply across tables and are enforced while streaming;
archive size alone never proves the expanded data is safe. Provision scratch disk
space for the expanded data. Upload tarball limits remain separate.

The data transaction uses a 10 second lock timeout and a 15 minute timeout per
statement. Timeout failures roll back table changes; PostgreSQL sequence counters
may retain forward gaps. Automatically provisioned restore credentials are sent to
PostgreSQL as salted SCRAM-SHA-256 verifiers rather than plaintext passwords.
