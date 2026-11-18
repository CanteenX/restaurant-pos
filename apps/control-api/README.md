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
