# Nventra Control API

Run from the monorepo root after installing workspace dependencies.

```sh
pnpm --filter @nventra/control-api build
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
