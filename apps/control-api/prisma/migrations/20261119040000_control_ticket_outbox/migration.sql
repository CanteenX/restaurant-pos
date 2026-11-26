BEGIN;
ALTER TABLE control.ticket_message DROP CONSTRAINT message_kind, ADD CONSTRAINT message_kind CHECK (
  (direction = 'internal' AND visibility = 'staff' AND author_id IS NOT NULL AND request_key IS NOT NULL AND length(text) <= 4000)
  OR (direction = 'inbound' AND visibility = 'public' AND author_id IS NULL AND request_key IS NULL AND octet_length(text) <= 65536)
  OR (direction = 'outbound' AND visibility = 'public' AND author_id IS NOT NULL AND request_key IS NOT NULL AND length(text) <= 4000)
);
CREATE TABLE control.ticket_reply_outbox (
  message_row_id uuid PRIMARY KEY, message_direction varchar(8) NOT NULL DEFAULT 'outbound' CHECK (message_direction='outbound'),
  UNIQUE (message_row_id,message_direction),
  FOREIGN KEY (message_row_id,message_direction) REFERENCES control.ticket_message(id,direction),
  message_id varchar(254) NOT NULL UNIQUE CHECK (message_id = '<' || message_row_id::text || '@nventra.invalid>'),
  in_reply_to varchar(254), recipient varchar(254) NOT NULL CHECK (recipient ~ '^[^@,;<>[:space:][:cntrl:]]+@[a-z0-9.-]+$'),
  subject varchar(250) NOT NULL CHECK (subject <> '' AND subject !~ '[[:cntrl:]]'),
  rendered_text text NOT NULL CHECK (length(rendered_text) BETWEEN 1 AND 65536),
  rendered_html text NOT NULL CHECK (length(rendered_html) BETWEEN 1 AND 524288),
  acknowledged_unverified boolean NOT NULL, state varchar(8) NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','sending','failed','held','sent')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_token uuid, lease_until timestamptz,
  CHECK ((lease_token IS NOT NULL) = (state='sending') AND (lease_until IS NOT NULL) = (state='sending'))
);
CREATE INDEX outbox_available_idx ON control.ticket_reply_outbox(state,available_at,message_row_id);
CREATE INDEX outbox_lease_idx ON control.ticket_reply_outbox(state,lease_until);
CREATE TABLE control.outbox_daily_quota (day date PRIMARY KEY, attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 100));
REVOKE ALL ON control.ticket_reply_outbox, control.outbox_daily_quota FROM PUBLIC,control_runtime;
GRANT SELECT (message_row_id,message_direction,state,acknowledged_unverified) ON control.ticket_reply_outbox TO control_runtime;
GRANT SELECT (message_row_id,outcome,claimed_sender,verified_sender,rfc_message_id) ON control.inbound_receipt TO control_runtime;

CREATE FUNCTION control.enqueue_ticket_reply(p_row uuid,p_ticket uuid,p_parent uuid,p_author uuid,p_key uuid,p_body text,
  p_message_id text,p_subject text,p_rendered_text text,p_rendered_html text,p_ack boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE source record;
BEGIN
  PERFORM 1 FROM control.ticket WHERE id=p_ticket FOR UPDATE;
  SELECT r.claimed_sender,r.verified_sender,r.rfc_message_id,m.id INTO source FROM control.ticket_message m
    JOIN control.inbound_receipt r ON r.message_row_id=m.id AND r.outcome='accept'
    WHERE m.ticket_id=p_ticket AND m.direction='inbound' ORDER BY m.sequence LIMIT 1;
  IF NOT FOUND OR source.id IS DISTINCT FROM p_parent OR source.claimed_sender IS NULL
    OR (source.verified_sender IS DISTINCT FROM source.claimed_sender AND p_ack IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'Ineligible reply target' USING ERRCODE='23514';
  END IF;
  INSERT INTO control.ticket_message(id,ticket_id,sequence,request_key,author_id,text,direction,visibility)
    SELECT p_row,p_ticket,coalesce(max(sequence),0)+1,p_key,p_author,p_body,'outbound','public'
    FROM control.ticket_message WHERE ticket_id=p_ticket;
  INSERT INTO control.ticket_reply_outbox(message_row_id,message_id,in_reply_to,recipient,subject,rendered_text,rendered_html,acknowledged_unverified)
    VALUES (p_row,p_message_id,source.rfc_message_id,source.claimed_sender,p_subject,p_rendered_text,p_rendered_html,p_ack);
END $$;

CREATE FUNCTION control.claim_ticket_reply() RETURNS TABLE(row_id uuid,token uuid,attempt integer,
  recipient text,subject text,message_id text,in_reply_to text,rendered_text text,rendered_html text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  -- SMTP may have accepted an expired send. Retire a bounded number without retrying them.
  UPDATE control.ticket_reply_outbox SET state='held',lease_token=NULL,lease_until=NULL WHERE message_row_id IN (
    SELECT o.message_row_id FROM control.ticket_reply_outbox o WHERE o.state='sending' AND o.lease_until<=clock_timestamp()
    ORDER BY o.lease_until,o.message_row_id LIMIT 8 FOR UPDATE SKIP LOCKED);
  SELECT o.message_row_id INTO candidate FROM control.ticket_reply_outbox o
    WHERE o.state='queued' AND o.available_at<=clock_timestamp() AND o.attempts<3
    ORDER BY o.available_at,o.message_row_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO control.outbox_daily_quota AS q(day,attempts) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date,1)
    ON CONFLICT(day) DO UPDATE SET attempts=q.attempts+1 WHERE q.attempts<100;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY UPDATE control.ticket_reply_outbox o SET state='sending',attempts=o.attempts+1,
    lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds' WHERE o.message_row_id=candidate
    RETURNING o.message_row_id,o.lease_token,o.attempts,o.recipient::text,o.subject::text,o.message_id::text,o.in_reply_to::text,o.rendered_text,o.rendered_html;
END $$;

CREATE FUNCTION control.finish_ticket_reply(p_row uuid,p_token uuid,p_state text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE control.ticket_reply_outbox SET
    state=CASE WHEN lease_until<=clock_timestamp() THEN 'held' WHEN p_state='queued' AND attempts>=3 THEN 'failed' ELSE p_state END,
    available_at=CASE WHEN p_state='queued' THEN clock_timestamp()+CASE attempts WHEN 1 THEN interval '60 seconds' ELSE interval '300 seconds' END ELSE available_at END,
    lease_token=NULL,lease_until=NULL
  WHERE message_row_id=p_row AND state='sending' AND lease_token=p_token AND p_state IN ('queued','sent','failed','held')
  RETURNING state::text;
$$;
REVOKE ALL ON FUNCTION control.enqueue_ticket_reply(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,boolean),
  control.claim_ticket_reply(),control.finish_ticket_reply(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.enqueue_ticket_reply(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,boolean) TO control_runtime;
COMMIT;
