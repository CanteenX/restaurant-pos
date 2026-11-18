# Control Center mail scheduler

Use the owner’s existing host and a dedicated Control PostgreSQL database. Each OS scheduler invocation handles one inbox poll or one outbox drain. The workers are independent of the Control web process and the POS. No subscription or hosted cron service is required.

## Before enabling live mail

1. Keep `CONTROL_MAIL_ENABLED` absent or set to `false` while testing. Disabled runs open no worker database session or mail connection. Obtain owner approval for the mailbox and retention before enabling it.
2. Apply the Control migrations, then have a database administrator create a separate restricted login for the scheduler with membership in the `control_mail_worker NOLOGIN` group. Apply [mail-worker-grants.sql](mail-worker-grants.sql) as the migration owner. The scheduler account should have no staff, operator, migration or database owner privileges. Use a local authenticated connection or verified database TLS.
3. Use the host’s secret manager to inject the scheduler-only variables into its process environment. Scope access to the scheduler service account and the owner. Keep values out of task arguments, task XML, logs, shell history and checked-in configuration.

| Variable | Meaning |
| --- | --- |
| `CONTROL_MAIL_ENABLED` | Exact `true` opts in. Absent or `false` leaves mail disabled. |
| `CONTROL_MAIL_DATABASE_URL` | Dedicated restricted worker login to the Control database. |
| `CONTROL_GMAIL_USER` | Owner-approved Gmail mailbox. |
| `CONTROL_GMAIL_APP_PASSWORD` | App password entered by the owner through the host secret store. |
| `CONTROL_MAIL_RETENTION_DAYS` | Positive whole number approved by the owner. Supply it explicitly. |

Real mail activation also requires a tested retention procedure, including backups. The scheduler records the approved interval in its configuration. Purging is an operator responsibility using a separate identity. Before enabling real mail, agree how to remove expired message and sender content while preserving the opaque delivery keys and cursor required to avoid replay. Preserve pending delivery and ambiguous outcomes until reconciled. Confirm the same policy for mail kept in Gmail.

## Windows Task Scheduler and cron

Run the built Control mail entry point from the installed `apps/control-api` directory. Set up one invocation for inbox processing and one for outbox processing, staggered on a 2–5 minute cadence. Use the absolute Node path, a dedicated non-interactive OS account and process-scoped secrets injected by the host.

- **Windows Task Scheduler.** Choose the option to run whether or not the account is logged on. Set the working directory to the installed Control API directory. Under Settings, choose “Do not start a new instance” and cap each invocation at two minutes.
- **Linux cron.** Use the dedicated account’s crontab. Run each invocation under a nonblocking `flock` for that job and a two-minute `timeout`. Store lock files in an account-owned directory and use absolute executable paths.

The one-shot driver requests cooperative cancellation after one minute and closes its verified worker session before returning. The database lease and outbox state remain authoritative when a host restarts or a task times out. Use redacted job status and the Control queue for diagnosis. If a send has an ambiguous outcome, check the mailbox’s Sent folder before an operator attempts another send.

Test the schedule using disposable PostgreSQL and synthetic mail. Leave the live tasks disabled until the owner supplies the mailbox credentials and confirms the retention procedure.
