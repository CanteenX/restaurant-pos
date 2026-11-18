# Nventra Control API

Run from the monorepo root after installing workspace dependencies.

```sh
pnpm --filter @nventra/control-api... build
CONTROL_API_PORT=4002 pnpm --filter @nventra/control-api start
curl --fail http://localhost:4002/api/control/v1/health
```

The liveness check covers the HTTP process. Database integration is a separate
Control Center task. The bootstrap takes a dedicated listen port from
`CONTROL_API_PORT` and uses no POS database settings.

## Audit storage

Use a separate PostgreSQL 16 database for the Control API. Provision a migration
login that owns the Control objects and a dedicated runtime login that inherits
the non-login group `control_runtime`. A database administrator creates the group
and assigns membership before migration. Run the migration with the migration
connection in `CONTROL_DATABASE_URL`, then configure the runtime connection
separately with its narrower credentials. Do not give the runtime ownership.
Use the `control` schema in the connection configuration.

```sh
pnpm --filter @nventra/control-api exec prisma migrate deploy
```

The append primitive takes the same transaction as the domain change. Database
grants allow the runtime to select events and execute the append function. Keep
checkpoint exports in an independently controlled location and verify against
those exports after a restore. A checkpoint vouches for the prefix it covers.

Audit integration tests require a disposable local PostgreSQL instance with a database named
`control_audit_test`, passed through `CONTROL_AUDIT_TEST_DATABASE_URL`. The
ci-gate uses its existing disposable PostgreSQL service and creates a separate
database for these tests; it keeps the POS schema and migration history separate.

## Staff authentication

Staff routes require a dedicated runtime connection in `CONTROL_DATABASE_URL`, a
64-hex-character `CONTROL_AUTH_KEY` from the operator's secret store, and the
exact HTTPS browser origin in `CONTROL_ORIGIN`. Preserve the key across restarts
and backups. Changing it invalidates outstanding credentials and requires factor
re-enrollment. With all three settings absent the bootstrap serves health only.
Partial configuration prevents startup.

An operator with provisioning privileges adds each eligible staff row, including
the owner, to the Control database with a UUID, normalized email and a bcrypt
password hash (cost 12, maximum 72 UTF-8 bytes). The API's runtime role cannot
create or enable staff accounts. There is no public signup or owner bypass.

POST `/staff/session/challenge` with email and password. A new challenge
supersedes the staff member's previous challenge and expires after five minutes.
For first-time enrollment the operator separately supplies a single-use 32-byte
proof over a trusted channel and provisions its SHA-256 digest and expiry in
Control. Include the proof as unpadded base64url in `enrollmentProof`. The API
consumes it before returning a base32 seed. If the response is lost, the
operator must issue a fresh proof. Confirm the seed with the
challenge and six-digit code at `/staff/enrollment` and save the returned
recovery codes. Later logins use `/staff/session/verify` with the challenge and
TOTP or one unused recovery code. Both endpoints issue an eight-hour secure
host-only HttpOnly session cookie after verification. GET `/staff/session`
returns the current staff ID and verification time. POST `/staff/session/logout`
revokes that session. Browser POSTs require the configured Origin.

Rate limits use shared PostgreSQL counters per staff account and socket peer.
A reverse proxy shares its peer quota across users. Forwarded address headers
are ignored. Deploy behind a reviewed TLS endpoint and restrict direct access.

Staff grants default to an empty set. The provisioning operator explicitly assigns
the first administrator's grants. `GET /staff/users` requires `cc.staff.read`
and accepts a UUID cursor and a limit of 1–50. Grant replacement, session
revocation and factor reset require `cc.staff.manage` and verification within
ten minutes. Sign in again to refresh verification. Management uses the
actor's and target's stored grants and rejects self or peer administration.

Use `PATCH /staff/users/:id/grants` with a grants array. POST an empty object
to `/staff/users/:id/revoke-sessions` or `/staff/users/:id/reset-factor`.
Both clear outstanding sessions, challenges and enrollment proofs. A reset also
clears the authenticator and recovery codes. The operator must provision a fresh
out-of-band proof for re-enrollment. Disablement, re-enablement and password
changes invalidate outstanding sessions at the database boundary.
