BEGIN;
ALTER TABLE control.ticket ADD CONSTRAINT ticket_portal_scope_key UNIQUE (id,business_id);
ALTER TABLE control.portal_account ADD CONSTRAINT portal_account_ticket_scope_key UNIQUE (id,business_id);
CREATE TABLE control.portal_ticket (
  ticket_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  account_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_outlet_id uuid,
  UNIQUE (account_id,request_key),
  FOREIGN KEY (ticket_id,business_id) REFERENCES control.ticket(id,business_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id,business_id) REFERENCES control.portal_account(id,business_id) ON DELETE RESTRICT
);
CREATE INDEX portal_ticket_owner_idx ON control.portal_ticket(account_id,ticket_id);
REVOKE ALL ON control.portal_ticket FROM PUBLIC,control_runtime;
GRANT SELECT (ticket_id) ON control.portal_ticket TO control_runtime;

-- Keep the existing hash and history format. Only controlled writers may use customer attribution.
ALTER TABLE control.audit_event DROP CONSTRAINT audit_event_actor_type_check,
  ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('staff','service','system','customer'));
ALTER FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) RENAME TO append_audit_event_core;
CREATE FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF $1='customer' THEN RAISE EXCEPTION 'Invalid audit writer' USING ERRCODE='42501'; END IF;
  RETURN control.append_audit_event_core($1,$2,$3,$4,$5,$6,$7,$8,$9);
END $$;
REVOKE ALL ON FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) TO control_runtime;
REVOKE ALL ON FUNCTION control.append_audit_event_core(text,uuid,uuid,text,text,uuid,uuid,text,text[]) FROM PUBLIC,control_runtime;
DO $$ BEGIN
  IF to_regrole('control_mail_worker') IS NOT NULL THEN
    IF has_function_privilege('control_mail_worker','control.append_audit_event_core(text,uuid,uuid,text,text,uuid,uuid,text,text[])','EXECUTE') THEN
      GRANT EXECUTE ON FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) TO control_mail_worker;
    END IF;
    REVOKE ALL ON FUNCTION control.append_audit_event_core(text,uuid,uuid,text,text,uuid,uuid,text,text[]) FROM control_mail_worker;
  END IF;
END $$;

CREATE FUNCTION control.portal_owns_ticket(p_ticket uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (SELECT FROM control.portal_ticket p JOIN control.portal_account a ON a.id=p.account_id
    WHERE p.ticket_id=p_ticket AND a.status='active'
      AND p.business_id=NULLIF(current_setting('control.portal_business_id',true),'')::uuid
      AND p.account_id=NULLIF(current_setting('control.portal_account_id',true),'')::uuid)
$$;
CREATE VIEW control.portal_ticket_header WITH (security_barrier=true) AS
  SELECT t.id,t.subject,t.status,t.outlet_id,t.updated_at
  FROM control.portal_business_snapshot() b JOIN control.portal_ticket p ON p.business_id=b.id
  JOIN control.ticket t ON t.id=p.ticket_id
  WHERE b.hosted_status='active' AND p.account_id=NULLIF(current_setting('control.portal_account_id',true),'')::uuid;
CREATE VIEW control.portal_ticket_conversation WITH (security_barrier=true) AS
  SELECT m.id,m.ticket_id,m.sequence,m.direction,m.text AS body,m.created_at
  FROM control.portal_ticket_header h JOIN control.ticket_message m ON m.ticket_id=h.id
  WHERE m.visibility='public' AND (
    (m.direction='inbound' AND m.sequence=1 AND NOT EXISTS (SELECT FROM control.inbound_receipt r WHERE r.message_row_id=m.id))
    OR (m.direction='outbound' AND NOT EXISTS (SELECT FROM control.ticket_reply_outbox o WHERE o.message_row_id=m.id))
  );
REVOKE ALL ON control.portal_ticket_header,control.portal_ticket_conversation FROM PUBLIC;

CREATE FUNCTION control.portal_open_ticket(p_request uuid,p_outlet uuid,p_subject text,p_text text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  tenant uuid := NULLIF(current_setting('control.portal_business_id',true),'')::uuid;
  account uuid := NULLIF(current_setting('control.portal_account_id',true),'')::uuid;
  new_ticket uuid := gen_random_uuid();
  previous record;
BEGIN
  IF NOT EXISTS (SELECT FROM control.portal_business_snapshot() b WHERE b.id=tenant AND b.hosted_status='active') THEN
    RAISE EXCEPTION 'Portal ticket unavailable' USING ERRCODE='NV403';
  END IF;
  IF p_request IS NULL OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 240 OR p_subject !~ '[^[:space:]]'
    OR p_subject ~ '[[:cntrl:]]' OR p_text IS NULL OR length(p_text) NOT BETWEEN 1 AND 4000
    OR p_text !~ '[^[:space:]]' OR translate(p_text,E'\n\t','') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid portal ticket' USING ERRCODE='NV400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('control.portal.ticket:' || account::text || ':' || p_request::text,0));
  SELECT p.ticket_id,p.request_outlet_id,t.subject,m.text INTO previous
    FROM control.portal_ticket p JOIN control.ticket t ON t.id=p.ticket_id
    JOIN control.ticket_message m ON m.ticket_id=p.ticket_id AND m.sequence=1
    WHERE p.account_id=account AND p.request_key=p_request;
  IF FOUND THEN
    IF (previous.request_outlet_id,previous.subject,previous.text) IS DISTINCT FROM (p_outlet,p_subject,p_text) THEN
      RAISE EXCEPTION 'Conflicting portal request' USING ERRCODE='NV409';
    END IF;
    RETURN previous.ticket_id;
  END IF;
  IF p_outlet IS NOT NULL AND NOT EXISTS (
    SELECT FROM control.outlet o WHERE o.id=p_outlet AND o.business_id=tenant AND NOT o.archived
  ) THEN
    RAISE EXCEPTION 'Invalid portal outlet' USING ERRCODE='NV400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('control.portal.ticket-rate:' || account::text,0));
  IF (SELECT count(*) FROM control.portal_ticket p JOIN control.ticket t ON t.id=p.ticket_id
      WHERE p.account_id=account AND t.created_at > clock_timestamp() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'Portal ticket rate limit' USING ERRCODE='NV429';
  END IF;
  INSERT INTO control.ticket(id,subject,business_id,outlet_id) VALUES (new_ticket,p_subject,tenant,p_outlet);
  INSERT INTO control.ticket_message(id,ticket_id,sequence,text,direction,visibility)
    VALUES (gen_random_uuid(),new_ticket,1,p_text,'inbound','public');
  INSERT INTO control.portal_ticket(ticket_id,business_id,account_id,request_key,request_outlet_id)
    VALUES (new_ticket,tenant,account,p_request,p_outlet);
  PERFORM control.append_audit_event_core('customer',account,tenant,'portal.ticket.open','ticket',new_ticket,
    p_request,'succeeded',ARRAY['subject','message','outletId']);
  RETURN new_ticket;
END $$;

CREATE FUNCTION control.publish_portal_ticket_reply(p_ticket uuid,p_actor uuid,p_request uuid,p_text text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant uuid; previous control.ticket_message%ROWTYPE; new_message uuid := gen_random_uuid(); next_sequence integer;
BEGIN
  SELECT t.business_id INTO tenant FROM control.ticket t JOIN control.portal_ticket p ON p.ticket_id=t.id
    WHERE t.id=p_ticket FOR UPDATE OF t;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_actor IS NULL OR p_request IS NULL OR p_text IS NULL OR length(p_text) NOT BETWEEN 1 AND 4000
    OR p_text !~ '[^[:space:]]' OR translate(p_text,E'\n\t','') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid portal reply' USING ERRCODE='NV400';
  END IF;
  SELECT * INTO previous FROM control.ticket_message WHERE ticket_id=p_ticket AND request_key=p_request;
  IF FOUND THEN
    IF (previous.direction,previous.visibility,previous.author_id,previous.text) IS DISTINCT FROM ('outbound','public',p_actor,p_text)
      OR EXISTS (SELECT FROM control.ticket_reply_outbox o WHERE o.message_row_id=previous.id) THEN
      RAISE EXCEPTION 'Conflicting portal reply' USING ERRCODE='NV409';
    END IF;
    RETURN previous.id;
  END IF;
  SELECT coalesce(max(sequence),0)+1 INTO next_sequence FROM control.ticket_message WHERE ticket_id=p_ticket;
  INSERT INTO control.ticket_message(id,ticket_id,sequence,author_id,request_key,text,direction,visibility)
    VALUES (new_message,p_ticket,next_sequence,p_actor,p_request,p_text,'outbound','public');
  UPDATE control.ticket SET updated_at=greatest(updated_at,clock_timestamp()) WHERE id=p_ticket;
  PERFORM control.append_audit_event('staff',p_actor,tenant,'ticket.portal.reply','ticket',p_ticket,p_request,'succeeded',ARRAY['reply']);
  RETURN new_message;
END $$;

REVOKE ALL ON FUNCTION control.portal_owns_ticket(uuid), control.portal_open_ticket(uuid,uuid,text,text),
  control.publish_portal_ticket_reply(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.publish_portal_ticket_reply(uuid,uuid,uuid,text) TO control_runtime;
COMMIT;
