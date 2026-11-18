BEGIN;
CREATE TABLE control.hosted_access_event (
  business_id uuid NOT NULL REFERENCES control.business(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES control.staff(id) ON DELETE RESTRICT,
  status varchar(9) NOT NULL CHECK (status IN ('active', 'suspended')),
  reason varchar(240) NOT NULL CHECK (reason <> '' AND reason = btrim(reason) AND reason !~ '[[:cntrl:]]'),
  revision integer NOT NULL CHECK (revision > 0),
  changed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (business_id, request_key),
  UNIQUE (business_id, revision)
);
REVOKE ALL ON control.hosted_access_event FROM PUBLIC, control_runtime;
GRANT SELECT, INSERT (business_id, request_key, actor_id, status, reason, revision)
  ON control.hosted_access_event TO control_runtime;

-- Preserve full-access operators with the exact previous permission catalog.
WITH prior(grants) AS (VALUES (ARRAY['cc.staff.read', 'cc.staff.manage', 'cc.business.read', 'cc.business.manage',
  'cc.plan.read', 'cc.plan.manage', 'cc.audit.read', 'cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply',
  'cc.billing.read', 'cc.billing.manage']))
UPDATE control.staff s SET grants = s.grants || ARRAY['cc.hosted.read', 'cc.hosted.manage'] FROM prior
WHERE s.grants @> prior.grants AND cardinality(s.grants) = cardinality(prior.grants);
COMMIT;
