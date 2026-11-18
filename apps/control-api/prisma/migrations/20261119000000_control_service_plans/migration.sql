BEGIN;
CREATE TABLE control.service_plan_version (
  code varchar(32) NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{0,31}$'),
  version integer NOT NULL CHECK (version > 0),
  label varchar(80) NOT NULL CHECK (btrim(label) <> ''),
  PRIMARY KEY (code, version)
);
INSERT INTO control.service_plan_version (code, version, label)
VALUES ('starter', 1, 'Starter'), ('pro', 1, 'Pro'), ('franchise', 1, 'Franchise');

CREATE TABLE control.outlet_service_term (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  request_key uuid NOT NULL,
  operation varchar(6) NOT NULL,
  plan_code varchar(32),
  plan_version integer,
  starts_at timestamptz(3),
  ends_at timestamptz(3),
  recorded_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id, outlet_id) REFERENCES control.outlet(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_code, plan_version) REFERENCES control.service_plan_version(code, version) ON DELETE RESTRICT,
  UNIQUE (outlet_id, revision),
  UNIQUE (outlet_id, request_key),
  CHECK (
    (operation = 'cancel' AND plan_code IS NULL AND plan_version IS NULL AND starts_at IS NULL AND ends_at IS NULL)
    OR (operation IN ('assign', 'renew') AND plan_code IS NOT NULL AND plan_version IS NOT NULL
      AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at < ends_at)
  )
);
REVOKE ALL ON control.service_plan_version, control.outlet_service_term FROM PUBLIC, control_runtime;
GRANT SELECT ON control.service_plan_version, control.outlet_service_term TO control_runtime;
GRANT INSERT ON control.outlet_service_term TO control_runtime;
COMMIT;
