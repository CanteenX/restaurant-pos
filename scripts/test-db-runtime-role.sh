#!/usr/bin/env bash
# Disposable PostgreSQL 16 check for the same setup/serve commands shipped in the image.
# Build the backend and generate Prisma before running. Run with the shared heavy-job lock.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "${BASH_SOURCE[0]}")/../apps/backend"

work="$(mktemp -d)"
pg="nventra-test-db-role-$$"
password="$(openssl rand -hex 32)"
cleanup() {
  if [ "$(docker inspect --format '{{index .Config.Labels "com.nventra.fixture"}}' "$pg" 2>/dev/null)" = 'db-runtime-role' ]; then
    docker rm -fv "$pg" >/dev/null
  fi
  rm -f "$work/runtime-url" "$work/setup.log" "$work/legacy.log"
  rmdir "$work"
}
trap cleanup EXIT

pg_query() {
  PGPASSWORD="$1" docker exec -e PGPASSWORD "$pg" psql -X -At -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -U "$2" -d "$3" -c "$4"
}

check() {
  local value
  value="$(pg_query "$runtime_password" "$runtime_user" nventra_pos "$1")"
  if [ "$value" != "$2" ]; then
    echo "FAIL: $3 (expected $2, got $value)" >&2
    exit 1
  fi
  echo "PASS: $3"
}

for scenario in fresh renamed pre-rename; do
  fixture_user=nventra
  fixture_db=nventra_pos
  if [ "$scenario" = pre-rename ]; then
    # Same pre-rename initdb identity as scripts/test-db-identity-upgrade.sh.
    fixture_user=nodedr
    fixture_db=nodedr_restaurant
  fi
  POSTGRES_PASSWORD="$password" docker run -d --name "$pg" --label com.nventra.fixture=db-runtime-role \
    -e POSTGRES_PASSWORD -e POSTGRES_USER="$fixture_user" -e POSTGRES_DB="$fixture_db" \
    -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
  port="$(docker port "$pg" 5432/tcp | cut -d: -f2)"
  for _ in $(seq 1 60); do
    if pg_query "$password" "$fixture_user" "$fixture_db" 'SELECT 1' >/dev/null 2>&1 &&
       (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then break; fi
    sleep 1
  done
  old_url="postgresql://$fixture_user:$password@127.0.0.1:$port/$fixture_db"
  bootstrap_url="postgresql://nventra:$password@127.0.0.1:$port/nventra_pos"
  export NVENTRA_DATABASE_URL_FILE="$work/runtime-url"
  if command -v cygpath >/dev/null 2>&1; then
    NVENTRA_DATABASE_URL_FILE="$(cygpath -am "$NVENTRA_DATABASE_URL_FILE")"
  fi
  if [ "$scenario" != fresh ]; then
    DATABASE_URL="$old_url" node node_modules/prisma/build/index.js migrate deploy >"$work/legacy.log" 2>&1
    pg_query "$password" "$fixture_user" "$fixture_db" 'UPDATE sync_state SET failures = 17 WHERE id = 1' >/dev/null
  fi

  DATABASE_BOOTSTRAP_URL="$bootstrap_url" sh ./container-entrypoint.sh setup >"$work/setup.log" 2>&1 || {
    echo "FAIL: $scenario setup" >&2; cat "$work/setup.log" >&2; exit 1;
  }
  runtime_user="$(node -p 'new URL(require("fs").readFileSync(process.env.NVENTRA_DATABASE_URL_FILE, "utf8")).username')"
  runtime_password="$(node -p 'new URL(require("fs").readFileSync(process.env.NVENTRA_DATABASE_URL_FILE, "utf8")).password')"

  check "SELECT current_user = 'nventra_runtime' AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) FROM pg_roles WHERE rolname = current_user" t "$scenario runtime login is limited"
  check "SELECT NOT pg_has_role('nventra_owner', 'MEMBER') AND NOT has_schema_privilege('public', 'CREATE') AND NOT has_database_privilege(current_database(), 'TEMP')" t "$scenario runtime has no role membership or schema creation"
  check "SELECT NOT has_table_privilege('sync_state', 'TRUNCATE, TRIGGER') AND NOT has_table_privilege('_prisma_migrations', 'INSERT, UPDATE, DELETE') AND has_table_privilege('_prisma_migrations', 'SELECT')" t "$scenario runtime has read-only migration history and DML without TRUNCATE or TRIGGER"
  check "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sync_state'" nventra_owner "$scenario migration owner owns data objects"
  check "SELECT NOT rolcanlogin AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) FROM pg_roles WHERE rolname = 'nventra_owner'" t "$scenario migration owner cannot log in between runs"
  check "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sync_log')" t "$scenario setup installed capture triggers"
  if [ "$scenario" != fresh ]; then
    check 'SELECT failures FROM sync_state WHERE id = 1' 17 "$scenario upgrade preserves an existing row"
  else
    check 'UPDATE sync_state SET failures = 3 WHERE id = 1 RETURNING failures' 3 'runtime can write application data'
    pg_query "$runtime_password" "$runtime_user" nventra_pos \
      "INSERT INTO restaurants (id, name, \"updatedAt\") VALUES ('fixture-r', 'fixture', now())" >/dev/null
    check 'SELECT public.sync_reset_for_adopt()' t 'adopt reset works through the limited runtime role'
    check 'SELECT count(*) FROM restaurants' 0 'adopt reset clears synced data'
    pg_query "$runtime_password" "$runtime_user" nventra_pos \
      "INSERT INTO restaurants (id, name, \"updatedAt\") VALUES ('fixture-r', 'fixture', now());
       INSERT INTO branches (id, \"restaurantId\", name, \"updatedAt\") VALUES ('fixture-b', 'fixture-r', 'fixture', now());
       INSERT INTO verifactu_records (id, \"restaurantId\", \"branchId\", \"issuerNif\", seq, type, \"invoiceType\",
         \"invoiceNumber\", \"issueDate\", \"taxTotalCents\", \"totalCents\", \"generatedAt\", hash, xml, environment)
         VALUES ('fixture-v', 'fixture-r', 'fixture-b', 'fixture', 1, 'ALTA', 'F1', 'fixture', 0, 0, 'fixture', 'fixture', 'fixture', 'TEST')" >/dev/null
    check 'SELECT public.sync_reset_for_adopt()' f 'adopt refuses to reset a nonempty fiscal ledger'
    check 'SELECT count(*) FROM verifactu_records' 1 'adopt preserves fiscal records'
    check 'SELECT count(*) FROM restaurants' 1 'adopt refusal preserves app records'
    pg_query "$password" nventra nventra_pos 'GRANT CREATE ON SCHEMA public TO nventra_runtime' >/dev/null
    if sh ./container-entrypoint.sh true >"$work/setup.log" 2>&1; then
      echo 'FAIL: managed startup accepted schema CREATE permission' >&2; exit 1
    fi
    echo 'PASS: managed startup refuses an elevated runtime login'
    pg_query "$password" nventra nventra_pos 'REVOKE CREATE ON SCHEMA public FROM nventra_runtime' >/dev/null
  fi
  DATABASE_BOOTSTRAP_URL="$bootstrap_url" sh ./container-entrypoint.sh setup >"$work/setup.log" 2>&1 || {
    echo "FAIL: $scenario repeated setup" >&2; exit 1;
  }
  check 'SELECT 1' 1 "$scenario runtime credentials survive repeated setup"
  docker rm -fv "$pg" >/dev/null
  rm -f "$work/runtime-url"
done
