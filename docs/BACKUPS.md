# Local scheduled backups (USB drive / NAS)

Nventra POS can copy a full backup to a folder you choose — an external USB
drive or a NAS share — on a schedule, so a dead server disk does not take
the only copy of your data with it. This is separate from, and can run
alongside, the S3 bucket backups in **Settings → Backup**.

Each backup is one folder named `nventra-backup-<UTC time>` containing:

| File | What |
|---|---|
| `db.dump` | Postgres custom-format dump (restore with `pg_restore --clean --if-exists`) |
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
