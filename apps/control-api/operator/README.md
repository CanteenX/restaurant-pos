# Owner-run staff provisioning

Use the operator command to invite the first owner and subsequent staff. Build it with `pnpm --filter @nventra/control-api... build` from the monorepo root. Run the following steps in the dedicated Control PostgreSQL 16 database after applying the Control migrations.

1. A database administrator creates a fresh `control_staff_operator NOLOGIN` group and a dedicated restricted login for the owner. Give that login membership in this group only. Use local authenticated access or a verified TLS connection and set its connection URI through the owner's secret store in `CONTROL_OPERATOR_DATABASE_URL`.
2. As the Control migration owner, apply [install.sql](install.sql) in one transaction. For example, from `apps/control-api`, run `psql -X -v ON_ERROR_STOP=1 -f operator/install.sql` with the migration owner's existing PostgreSQL service configuration. The group receives schema usage and execution of a single function. The API runtime retains its existing privileges.
3. Have the owner's secret manager stream one UTF-8 JSON object to `node dist/operator/provision.js` on a private pipe. The command accepts up to 4 KiB, refuses interactive terminal input and takes no arguments. Supply the connection separately through the operator environment. Keep shell tracing, diagnostic logging and command history free of input values.

| JSON field | Invitation | Replacement proof |
| --- | --- | --- |
| `operation` | `create` | `rotate` |
| `email` | Staff email, normalized on input | Existing staff email |
| `preset` | `OWNER`, `SUPPORT` or `SALES` | Omit |
| `password` | Owner-supplied passphrase of at least 12 characters and at most 72 UTF-8 bytes | Omit |
| `proof` | Independently supplied 32 random bytes encoded as unpadded base64url | A fresh proof in the same format |

Deliver the password and proof through independent trusted channels. The database stores a cost-12 bcrypt verifier and a SHA-256 proof digest. The proof expires after ten minutes and is consumed when the first enrollment challenge is issued. Explicit grants come from the chosen Control preset. Repeating an invitation fails without altering the account.

Use `rotate` after a staff factor reset or a lost first challenge. It requires an enabled account waiting for enrollment, retires prior challenges and sessions and replaces any pending proof. The command records each issued proof digest in a private per-staff history. Reusing a proof fails before any outstanding challenge or session changes, including after factor reset or reinstall. Installation also records any proofs currently pending in Control. Existing passwords and grants carry forward. On success the command exits silently with status 0. A rejected request exits with status 1 and a fixed diagnostic. The audit records the system provisioning identity, operation, staff UUID and request UUID.

To remove the command's database authority, apply [uninstall.sql](uninstall.sql) as the migration owner. The database administrator can then revoke the owner's operator membership and retire the dedicated role and login. Staff accounts, audit history and the private issuance history survive uninstall.
