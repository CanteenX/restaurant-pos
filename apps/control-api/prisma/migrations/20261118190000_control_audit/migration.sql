BEGIN;

CREATE SCHEMA IF NOT EXISTS control;

CREATE TABLE control.audit_event (
  sequence bigint PRIMARY KEY CHECK (sequence > 0),
  occurred_at_ms bigint NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'service', 'system')),
  actor_id uuid NOT NULL,
  business_id uuid,
  action text NOT NULL CHECK (action ~ '^[A-Za-z][A-Za-z0-9._]{0,63}$'),
  subject_type text NOT NULL CHECK (subject_type ~ '^[A-Za-z][A-Za-z0-9._]{0,63}$'),
  subject_id uuid,
  request_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    cardinality(changed_fields) <= 24 AND
    -- Array equality also checks its dimensions and lower bounds.
    changed_fields = string_to_array(array_to_string(changed_fields, ','), ',') AND
    array_to_string(changed_fields, ',') ~ '^([A-Za-z][A-Za-z0-9._]{0,63}(,[A-Za-z][A-Za-z0-9._]{0,63})*)?$'
  ),
  previous_hash text NOT NULL CHECK (previous_hash ~ '^[a-f0-9]{64}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$')
);

-- Keep inserts behind this function so even the runtime role cannot forge links.
CREATE FUNCTION control.append_audit_event(
  event_actor_type text, event_actor_id uuid, event_business_id uuid,
  event_action text, event_subject_type text, event_subject_id uuid,
  event_request_id uuid, event_outcome text, event_changed_fields text[]
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  tip control.audit_event%ROWTYPE;
  next_sequence bigint;
  previous_digest text;
  occurred_at bigint;
  digest text;
BEGIN
  -- Application namespace and audit-chain lock ID.
  PERFORM pg_advisory_xact_lock(1314276174, 1);
  SELECT * INTO tip FROM control.audit_event ORDER BY sequence DESC LIMIT 1;
  next_sequence := COALESCE(tip.sequence, 0) + 1;
  previous_digest := COALESCE(tip.event_hash, repeat('0', 64));
  occurred_at := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;

  -- Fixed-order ASCII fields; constraints forbid delimiter characters in codes.
  digest := encode(sha256(convert_to(array_to_string(ARRAY[
    next_sequence::text, occurred_at::text, event_actor_type, event_actor_id::text,
    COALESCE(event_business_id::text, ''), event_action, event_subject_type,
    COALESCE(event_subject_id::text, ''), event_request_id::text, event_outcome,
    array_to_json(event_changed_fields)::text, previous_digest
  ], '|'), 'UTF8')), 'hex');

  INSERT INTO control.audit_event (
    sequence, occurred_at_ms, actor_type, actor_id, business_id, action,
    subject_type, subject_id, request_id, outcome, changed_fields, previous_hash, event_hash
  ) VALUES (
    next_sequence, occurred_at, event_actor_type, event_actor_id, event_business_id, event_action,
    event_subject_type, event_subject_id, event_request_id, event_outcome, event_changed_fields,
    previous_digest, digest
  );
  RETURN next_sequence;
END;
$function$;

REVOKE ALL ON SCHEMA control FROM PUBLIC, control_runtime;
GRANT USAGE ON SCHEMA control TO control_runtime;
REVOKE ALL ON TABLE control.audit_event FROM PUBLIC, control_runtime;
GRANT SELECT ON TABLE control.audit_event TO control_runtime;
REVOKE ALL ON FUNCTION control.append_audit_event(text, uuid, uuid, text, text, uuid, uuid, text, text[])
  FROM PUBLIC, control_runtime;
GRANT EXECUTE ON FUNCTION control.append_audit_event(text, uuid, uuid, text, text, uuid, uuid, text, text[])
  TO control_runtime;

COMMIT;
