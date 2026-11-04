-- Multi-branch sync 2/4 (#81): change capture and durable outbox.
-- See docs/MULTI-BRANCH-SYNC.md §4–5.
--  * sync_changes is the ordered outbox: each change now carries a per-row
--    hybrid logical clock (hlc), the writing peer, the row's branch and the
--    schema version it was written with.
--  * sync_versions keeps the newest version (and delete tombstone) of every
--    row, so "is the incoming change newer?" survives outbox pruning (G7).
--  * sync_cursors records how far each client has pulled, so the server can
--    compact its log (G8).
-- The classification functions (sync_is_synced_table, sync_branch_of,
-- sync_capture_row) are regenerated from src/sync/tables.ts at every boot;
-- the versions below are only a safe starting point.

ALTER TABLE "sync_state" ADD COLUMN "schemaVersion" TEXT;

ALTER TABLE "sync_changes"
  ADD COLUMN "hlc" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "peer" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "schemaVersion" TEXT;

CREATE TABLE "sync_versions" (
  "tbl" TEXT NOT NULL,
  "pkKey" TEXT NOT NULL,
  "hlc" BIGINT NOT NULL,
  "peer" TEXT NOT NULL,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "branchId" TEXT,
  "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sync_versions_pkey" PRIMARY KEY ("tbl", "pkKey")
);

CREATE TABLE "sync_cursors" (
  "device" TEXT NOT NULL,
  "seq" BIGINT NOT NULL DEFAULT 0,
  "seenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("device")
);

-- Starting classification; replaced at boot from tables.ts. Device-local and
-- per-install-sealed tables stop syncing (G5, G10, G11).
CREATE OR REPLACE FUNCTION sync_is_synced_table(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT t NOT LIKE 'sync\_%' AND t NOT IN
    ('_prisma_migrations', 'backups', 'backup_config', 'local_backup_config',
     'webhook_deliveries', 'webhook_endpoints', 'download_stats', 'verifactu_records',
     'integration_logs', 'integration_outbox', 'integration_connections',
     'staff_api_keys', 'integration_api_keys', 'device_tokens', 'notifications',
     'permissions')
$$;

CREATE OR REPLACE FUNCTION sync_branch_of(t text, rec jsonb) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT rec ->> 'branchId' $$;

CREATE OR REPLACE FUNCTION sync_capture_row(t text, rec jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t = 'users' THEN rec - 'twoFactorSecret' ELSE rec END
$$;

-- Primary-key object of a captured row; permission references travel by key.
CREATE OR REPLACE FUNCTION sync_pk(cols text[], rec jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c text; pkv jsonb := '{}';
BEGIN
  FOREACH c IN ARRAY cols LOOP
    IF c = 'permissionId' AND rec ? 'permissionKey' THEN
      pkv := pkv || jsonb_build_object('permissionKey', rec -> 'permissionKey');
    ELSE
      pkv := pkv || jsonb_build_object(c, rec -> c);
    END IF;
  END LOOP;
  RETURN pkv;
END $$;

-- Row trigger. HLC = (ms << 16) + counter, advanced per row past the last
-- known version so a slow or rewound clock can't order an edit before the
-- one it replaced. A change applied from a peer keeps that peer's HLC.
-- app.sync_origin = '__skip' (client applying a pull) records the version
-- but writes no outbox entry.
CREATE OR REPLACE FUNCTION sync_log_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  origin text := coalesce(current_setting('app.sync_origin', true), '');
  remote text := nullif(current_setting('app.sync_hlc', true), '');
  st record;
  v sync_versions%ROWTYPE;
  rec jsonb;
  pkv jsonb;
  k text;
  h bigint;
  who text;
  br text;
  wall timestamptz := clock_timestamp();
BEGIN
  SELECT enabled, "deviceId", "schemaVersion" INTO st FROM sync_state WHERE id = 1;
  IF NOT coalesce(st.enabled, false) THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;
  rec := sync_capture_row(TG_TABLE_NAME, rec);
  pkv := sync_pk(TG_ARGV, rec);
  k := pkv::text;
  SELECT * INTO v FROM sync_versions WHERE tbl = TG_TABLE_NAME AND "pkKey" = k;
  IF remote IS NOT NULL THEN
    h := remote::bigint;
    who := coalesce(nullif(current_setting('app.sync_peer', true), ''), origin);
    wall := coalesce(nullif(current_setting('app.sync_ts', true), '')::timestamptz, wall);
  ELSE
    h := greatest(floor(extract(epoch FROM wall) * 1000)::bigint * 65536, coalesce(v.hlc, 0) + 1);
    who := st."deviceId";
  END IF;
  br := coalesce(sync_branch_of(TG_TABLE_NAME, rec), v."branchId");
  INSERT INTO sync_versions (tbl, "pkKey", hlc, peer, deleted, "branchId", ts)
  VALUES (TG_TABLE_NAME, k, h, who, TG_OP = 'DELETE', br, wall)
  ON CONFLICT (tbl, "pkKey") DO UPDATE
    SET hlc = EXCLUDED.hlc, peer = EXCLUDED.peer, deleted = EXCLUDED.deleted,
        "branchId" = EXCLUDED."branchId", ts = EXCLUDED.ts;
  IF origin = '__skip' THEN RETURN NULL; END IF;
  INSERT INTO sync_changes (tbl, pk, "pkKey", op, row, ts, origin, hlc, peer, "branchId", "schemaVersion")
  VALUES (TG_TABLE_NAME, pkv, k,
          CASE WHEN TG_OP = 'DELETE' THEN 'D' ELSE 'U' END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE rec END,
          wall, CASE WHEN origin = '' THEN 'local' ELSE origin END,
          h, who, br, st."schemaVersion");
  RETURN NULL;
END $$;

-- Installs the trigger on synced tables and removes it from tables that are
-- no longer synced. Idempotent; called at every boot.
CREATE OR REPLACE FUNCTION sync_install_triggers() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
     WHERE g.tgname = 'sync_log' AND c.relnamespace = 'public'::regnamespace
       AND NOT sync_is_synced_table(c.relname)
  LOOP
    EXECUTE format('DROP TRIGGER sync_log ON %I', r.relname);
  END LOOP;
  FOR r IN
    SELECT c.oid, c.relname,
           (SELECT string_agg(quote_literal(a.attname), ',' ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = ANY (k.conkey)) AS pkargs
      FROM pg_class c JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype = 'p'
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND sync_is_synced_table(c.relname)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = r.oid AND tgname = 'sync_log') THEN
      EXECUTE format('CREATE TRIGGER sync_log AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sync_log_change(%s)', r.relname, r.pkargs);
      n := n + 1;
    END IF;
  END LOOP;
  DELETE FROM sync_changes WHERE NOT sync_is_synced_table(tbl);
  RETURN n;
END $$;

-- Writes every existing row into the outbox with hlc 0 so any real edit wins.
CREATE OR REPLACE FUNCTION sync_seed() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname,
           (SELECT array_agg(a.attname::text ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = ANY (k.conkey)) AS pkcols
      FROM pg_class c JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype = 'p'
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND sync_is_synced_table(c.relname)
  LOOP
    EXECUTE format(
      'INSERT INTO sync_changes (tbl, pk, "pkKey", op, row, ts, origin, hlc, peer, "branchId", "schemaVersion")
         SELECT %L, sync_pk($1, x.r), sync_pk($1, x.r)::text, ''U'', x.r, ''epoch'', ''seed'', 0, ''seed'',
                sync_branch_of(%L, x.r), (SELECT "schemaVersion" FROM sync_state WHERE id = 1)
           FROM (SELECT sync_capture_row(%L, to_jsonb(t)) AS r FROM %I t) x',
      r.relname, r.relname, r.relname, r.relname) USING r.pkcols;
  END LOOP;
  UPDATE sync_state SET seeded = true WHERE id = 1;
END $$;

SELECT sync_install_triggers();
